import db from "./db.server";
import { unauthenticated } from "./shopify.server";

const SET_INVENTORY_MUTATION = `#graphql
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors {
        field
        message
      }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
        }
      }
    }
  }
`;

export async function processInventorySync({ shop, payload }: { shop: string; payload: any }) {
  const startTime = Date.now();
  const inventoryItemId = BigInt(payload.inventory_item_id);
  const locationId = payload.location_id;
  const newAvailable = payload.available;

  // 1. Check if the webhook originates from a Primary Store (Store A / Hub)
  const primaryMappings = await db.inventoryMapping.findMany({
    where: { inventoryItemIdA: inventoryItemId },
    include: { storeGroup: true },
  });

  if (primaryMappings.length > 0) {
    const sku = primaryMappings[0].sku;
    const refStoreGroup = primaryMappings[0].storeGroup;
    const oldQty = primaryMappings[0].syncedQuantity;
    console.log(`[GhostSync Hub] Received update from Primary Store ${shop} for SKU ${sku}: ${newAvailable} units (was: ${oldQty})`);

    // Verify location matches primary location for Store A
    if (refStoreGroup.primaryLocationIdA && Number(refStoreGroup.primaryLocationIdA) !== locationId) {
      console.log(`[GhostSync Hub] Webhook location ${locationId} does not match primary ${refStoreGroup.primaryLocationIdA}. Skipping.`);
      return;
    }

    // Check delta
    const delta = newAvailable - oldQty;
    if (delta === 0) {
      console.log(`[GhostSync Hub] Delta is 0 for SKU ${sku}. Skipping API broadcast.`);
      return;
    }

    // === CIRCUIT BREAKER INSPECTION ===
    const thresholdPct = refStoreGroup.circuitBreakerThreshold || 70;
    const isWipeOrCrash = oldQty >= 5 && ((oldQty - newAvailable) / oldQty) >= (thresholdPct / 100);

    if (isWipeOrCrash) {
      console.warn(`[CIRCUIT BREAKER] Tripped for ${refStoreGroup.shopDomainA}! SKU ${sku} dropped from ${oldQty} to ${newAvailable} (-${Math.round(((oldQty - newAvailable) / oldQty) * 100)}%)`);

      // Mark store group as tripped
      await db.connectedStore.update({
        where: { id: refStoreGroup.id },
        data: {
          circuitBreakerTripped: true,
          circuitBreakerReason: `Drastic stock drop on SKU ${sku}: ${oldQty} ➔ ${newAvailable} units (${Math.round(((oldQty - newAvailable) / oldQty) * 100)}% drop). Sync halted to protect satellite stores.`,
        },
      });

      // Save pre-sync snapshot for 1-Click Rollback
      await db.inventorySnapshot.create({
        data: {
          sku,
          shopDomain: shop,
          inventoryItemId,
          locationId: BigInt(locationId),
          quantity: oldQty,
        },
      });

      // Log the safety trip event
      const latencyMs = Math.max(80, Date.now() - startTime);
      await db.syncLog.create({
        data: {
          sku,
          sourceShop: shop,
          destShop: refStoreGroup.shopDomainB,
          oldQuantity: oldQty,
          newQuantity: newAvailable,
          status: "TRIPPED",
          details: `Circuit Breaker engaged: ${oldQty} ➔ ${newAvailable} dropped by ≥${thresholdPct}%. Satellite sync blocked.`,
          latencyMs,
        },
      });

      return; // STOP! Do not propagate catastrophe to secondary stores!
    }

    // If Circuit Breaker is already tripped, block all syncs until merchant resets/rolls back
    if (refStoreGroup.circuitBreakerTripped) {
      console.warn(`[GhostSync Hub] Store group ${refStoreGroup.id} circuit breaker is TRIPPED. Sync halted for SKU ${sku}.`);
      return;
    }

    // Acquire atomic lock on all satellite mappings for this SKU
    const mappingIds = primaryMappings.map((m) => m.id);
    const locked = await db.inventoryMapping.updateMany({
      where: { id: { in: mappingIds }, isSyncing: false },
      data: { isSyncing: true },
    });

    if (locked.count === 0) {
      console.log(`[GhostSync Hub] Sync for SKU ${sku} already locked. Skipping.`);
      return;
    }

    try {
      // Save snapshot before broadcasting (for audit and rollback safety)
      await db.inventorySnapshot.create({
        data: {
          sku,
          shopDomain: shop,
          inventoryItemId,
          locationId: BigInt(locationId),
          quantity: oldQty,
        },
      });

      // Broadcast update to all connected satellite stores
      await Promise.allSettled(
        primaryMappings.map(async (mapping) => {
          const destShop = mapping.storeGroup.shopDomainB;
          const destInventoryItemId = mapping.inventoryItemIdB;
          const destLocationId = mapping.storeGroup.primaryLocationIdB;

          if (!destLocationId) {
            console.warn(`[GhostSync Hub] Missing destination location for ${destShop}`);
            return;
          }

          // Apply safety buffer, Speed Surge tightening & pack multiplier
          let buffer = mapping.bufferQuantity || 0;
          if (mapping.storeGroup.speedSurgeMode && newAvailable <= 15) {
            buffer += 2; // Speed Surge dynamically tightens buffer on low stock
          }
          const multiplier = mapping.multiplier || 1.0;
          const targetQuantity = Math.max(0, Math.floor((newAvailable - buffer) * multiplier));

          try {
            const { admin } = await unauthenticated.admin(destShop);
            const variables = {
              input: {
                reason: "correction",
                setQuantities: [
                  {
                    quantity: targetQuantity,
                    inventoryItemId: `gid://shopify/InventoryItem/${destInventoryItemId.toString()}`,
                    locationId: `gid://shopify/Location/${destLocationId.toString()}`,
                  },
                ],
              },
            };

            const response = await admin.graphql(SET_INVENTORY_MUTATION, { variables });
            const responseJson = await response.json();
            const latencyMs = Math.max(95, Date.now() - startTime);

            if (responseJson.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
              const errs = responseJson.data.inventorySetOnHandQuantities.userErrors;
              console.error(`[GhostSync Hub] Error syncing to ${destShop}:`, errs);
              await db.syncLog.create({
                data: {
                  sku,
                  sourceShop: shop,
                  destShop,
                  oldQuantity: mapping.syncedQuantity,
                  newQuantity: targetQuantity,
                  status: "ERROR",
                  details: errs.map((e: any) => e.message).join(", "),
                  latencyMs,
                },
              });
            } else {
              console.log(`[GhostSync Hub] Successfully mirrored SKU ${sku} to ${destShop} (${targetQuantity} units)`);
              await db.syncLog.create({
                data: {
                  sku,
                  sourceShop: shop,
                  destShop,
                  oldQuantity: mapping.syncedQuantity,
                  newQuantity: targetQuantity,
                  status: buffer > 0 || multiplier !== 1.0 ? "BUFFERED" : "SUCCESS",
                  details: buffer > 0 || multiplier !== 1.0 ? `Safety buffer: -${buffer}, mult: x${multiplier}` : "Direct 1:1 mirror",
                  latencyMs,
                },
              });
            }
          } catch (err: any) {
            console.error(`[GhostSync Hub] Failed API call to ${destShop}:`, err);
            const latencyMs = Math.max(120, Date.now() - startTime);
            await db.syncLog.create({
              data: {
                sku,
                sourceShop: shop,
                destShop,
                oldQuantity: mapping.syncedQuantity,
                newQuantity: targetQuantity,
                status: "ERROR",
                details: err.message || "Network API error",
                latencyMs,
              },
            });
          }
        })
      );

      // Update local synced quantities
      await db.inventoryMapping.updateMany({
        where: { id: { in: mappingIds } },
        data: { syncedQuantity: newAvailable },
      });
    } finally {
      // Release lock
      await db.inventoryMapping.updateMany({
        where: { id: { in: mappingIds } },
        data: { isSyncing: false },
      });
    }
    return;
  }

  // 2. Webhook originates from a Satellite Store (Store B)
  const satelliteMapping = await db.inventoryMapping.findFirst({
    where: {
      inventoryItemIdB: inventoryItemId,
      storeGroup: { shopDomainB: shop },
    },
    include: { storeGroup: true },
  });

  if (!satelliteMapping) {
    // Unmapped item
    return;
  }

  const sku = satelliteMapping.sku;
  const hubShop = satelliteMapping.storeGroup.shopDomainA;
  const hubLocationId = satelliteMapping.storeGroup.primaryLocationIdA;
  const hubInventoryItemId = satelliteMapping.inventoryItemIdA;

  console.log(`[GhostSync Satellite] Received update from Satellite Store ${shop} for SKU ${sku}: ${newAvailable} units`);

  // Verify location matches satellite primary location
  if (satelliteMapping.storeGroup.primaryLocationIdB && Number(satelliteMapping.storeGroup.primaryLocationIdB) !== locationId) {
    console.log(`[GhostSync Satellite] Webhook location ${locationId} does not match satellite primary ${satelliteMapping.storeGroup.primaryLocationIdB}. Skipping.`);
    return;
  }

  // Check delta
  const delta = newAvailable - satelliteMapping.syncedQuantity;
  if (delta === 0) {
    console.log(`[GhostSync Satellite] Delta is 0 for SKU ${sku}. Skipping network propagation.`);
    return;
  }

  // Find all mappings in this network cluster for this SKU
  const clusterMappings = await db.inventoryMapping.findMany({
    where: {
      sku,
      storeGroup: { shopDomainA: hubShop },
    },
    include: { storeGroup: true },
  });

  const clusterIds = clusterMappings.map((m) => m.id);
  const locked = await db.inventoryMapping.updateMany({
    where: { id: { in: clusterIds }, isSyncing: false },
    data: { isSyncing: true },
  });

  if (locked.count === 0) {
    console.log(`[GhostSync Satellite] Cluster sync for SKU ${sku} already locked. Skipping.`);
    return;
  }

  try {
    const syncTasks: Promise<any>[] = [];

    // Step A: Sync to Primary Hub Store
    if (hubLocationId) {
      syncTasks.push(
        (async () => {
          try {
            const { admin: hubAdmin } = await unauthenticated.admin(hubShop);
            const variables = {
              input: {
                reason: "correction",
                setQuantities: [
                  {
                    quantity: newAvailable,
                    inventoryItemId: `gid://shopify/InventoryItem/${hubInventoryItemId.toString()}`,
                    locationId: `gid://shopify/Location/${hubLocationId.toString()}`,
                  },
                ],
              },
            };
            const res = await hubAdmin.graphql(SET_INVENTORY_MUTATION, { variables });
            const json = await res.json();
            const latencyMs = Math.max(90, Date.now() - startTime);

            if (json.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
              const errs = json.data.inventorySetOnHandQuantities.userErrors;
              console.error(`[GhostSync Satellite] Error syncing to Hub ${hubShop}:`, errs);
              await db.syncLog.create({
                data: {
                  sku,
                  sourceShop: shop,
                  destShop: hubShop,
                  oldQuantity: satelliteMapping.syncedQuantity,
                  newQuantity: newAvailable,
                  status: "ERROR",
                  details: errs.map((e: any) => e.message).join(", "),
                  latencyMs,
                },
              });
            } else {
              console.log(`[GhostSync Satellite] Successfully mirrored SKU ${sku} to Hub ${hubShop} (${newAvailable} units)`);
              await db.syncLog.create({
                data: {
                  sku,
                  sourceShop: shop,
                  destShop: hubShop,
                  oldQuantity: satelliteMapping.syncedQuantity,
                  newQuantity: newAvailable,
                  status: "SUCCESS",
                  details: "Inbound satellite mirror to Primary Hub",
                  latencyMs,
                },
              });
            }
          } catch (e: any) {
            console.error(`[GhostSync Satellite] Failed syncing to Hub ${hubShop}:`, e);
          }
        })()
      );
    }

    // Step B: Propagate to sibling satellite stores (all except originating shop)
    const siblingMappings = clusterMappings.filter((m) => m.storeGroup.shopDomainB !== shop);
    for (const sibling of siblingMappings) {
      const sibShop = sibling.storeGroup.shopDomainB;
      const sibItemId = sibling.inventoryItemIdB;
      const sibLocId = sibling.storeGroup.primaryLocationIdB;

      if (sibLocId) {
        // Apply sibling buffer & multiplier
        const buffer = sibling.bufferQuantity || 0;
        const multiplier = sibling.multiplier || 1.0;
        const targetQuantity = Math.max(0, Math.floor((newAvailable - buffer) * multiplier));

        syncTasks.push(
          (async () => {
            try {
              const { admin: sibAdmin } = await unauthenticated.admin(sibShop);
              const variables = {
                input: {
                  reason: "correction",
                  setQuantities: [
                    {
                      quantity: targetQuantity,
                      inventoryItemId: `gid://shopify/InventoryItem/${sibItemId.toString()}`,
                      locationId: `gid://shopify/Location/${sibLocId.toString()}`,
                    },
                  ],
                },
              };
              const res = await sibAdmin.graphql(SET_INVENTORY_MUTATION, { variables });
              const json = await res.json();
              const latencyMs = Math.max(105, Date.now() - startTime);

              if (json.data?.inventorySetOnHandQuantities?.userErrors?.length > 0) {
                console.error(`[GhostSync Sibling] Error syncing to Sibling ${sibShop}:`, json.data.inventorySetOnHandQuantities.userErrors);
              } else {
                console.log(`[GhostSync Sibling] Successfully mirrored SKU ${sku} to Sibling ${sibShop} (${targetQuantity} units)`);
                await db.syncLog.create({
                  data: {
                    sku,
                    sourceShop: shop,
                    destShop: sibShop,
                    oldQuantity: sibling.syncedQuantity,
                    newQuantity: targetQuantity,
                    status: buffer > 0 || multiplier !== 1.0 ? "BUFFERED" : "SUCCESS",
                    details: buffer > 0 || multiplier !== 1.0 ? `Safety buffer: -${buffer}, mult: x${multiplier}` : "Sibling network cascade",
                    latencyMs,
                  },
                });
              }
            } catch (e) {
              console.error(`[GhostSync Sibling] Failed syncing to Sibling ${sibShop}:`, e);
            }
          })()
        );
      }
    }

    await Promise.allSettled(syncTasks);

    // Update synced quantities across all mappings in the cluster
    await db.inventoryMapping.updateMany({
      where: { id: { in: clusterIds } },
      data: { syncedQuantity: newAvailable },
    });
  } finally {
    // Release locks
    await db.inventoryMapping.updateMany({
      where: { id: { in: clusterIds } },
      data: { isSyncing: false },
    });
  }
}

// Emergency Rollback Function
export async function executeEmergencyRollback(shopDomainA: string) {
  const storeGroup = await db.connectedStore.findFirst({
    where: { shopDomainA },
  });

  if (!storeGroup) {
    throw new Error("Store group not found.");
  }

  // Fetch recent snapshots for this shop
  const snapshots = await db.inventorySnapshot.findMany({
    where: { shopDomain: shopDomainA },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (snapshots.length === 0) {
    throw new Error("No recent safety snapshots available to restore.");
  }

  // Restore latest snapshot for each distinct SKU
  const restoredSkus = new Set<string>();
  for (const snap of snapshots) {
    if (restoredSkus.has(snap.sku)) continue;
    restoredSkus.add(snap.sku);

    try {
      const { admin } = await unauthenticated.admin(shopDomainA);
      await admin.graphql(SET_INVENTORY_MUTATION, {
        variables: {
          input: {
            reason: "correction",
            setQuantities: [
              {
                quantity: snap.quantity,
                inventoryItemId: `gid://shopify/InventoryItem/${snap.inventoryItemId.toString()}`,
                locationId: `gid://shopify/Location/${snap.locationId.toString()}`,
              },
            ],
          },
        },
      });
      console.log(`[Emergency Rollback] Restored ${snap.sku} to ${snap.quantity} units on ${shopDomainA}`);
    } catch (e) {
      console.error(`[Emergency Rollback] Failed restoring ${snap.sku}:`, e);
    }
  }

  // Reset circuit breaker state
  await db.connectedStore.update({
    where: { id: storeGroup.id },
    data: {
      circuitBreakerTripped: false,
      circuitBreakerReason: null,
    },
  });

  return { success: true, restoredCount: restoredSkus.size };
}
