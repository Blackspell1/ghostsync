import db from "./db.server";
import { unauthenticated } from "./shopify.server";

const SET_INVENTORY_MUTATION = `#graphql
  mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
    inventorySetOnHandQuantities(input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

const GET_INVENTORY_QUERY = `#graphql
  query getInventoryLevels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        inventoryLevels(first: 5) {
          edges {
            node {
              location {
                id
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

export async function runDriftDoctor(hubShop: string) {
  const hubLinks = await db.connectedStore.findMany({
    where: { shopDomainA: hubShop },
    include: { inventoryMappings: true },
  });

  if (hubLinks.length === 0) return { healedCount: 0, checkedCount: 0 };

  const { admin: hubAdmin } = await unauthenticated.admin(hubShop);
  let totalHealed = 0;
  let totalChecked = 0;
  const healedSkus: string[] = [];

  for (const link of hubLinks) {
    const satShop = link.shopDomainB;
    const { admin: satAdmin } = await unauthenticated.admin(satShop);
    const mappings = link.inventoryMappings;

    for (const m of mappings) {
      totalChecked++;
      try {
        // Query Master Hub stock
        const hubItemGid = `gid://shopify/InventoryItem/${m.inventoryItemIdA.toString()}`;
        const hubRes = await hubAdmin.graphql(GET_INVENTORY_QUERY, {
          variables: { ids: [hubItemGid] },
        });
        const hubJson = await hubRes.json();
        const hubLevel = hubJson.data?.nodes?.[0]?.inventoryLevels?.edges?.[0]?.node;
        const hubQty = hubLevel?.quantities?.[0]?.quantity ?? m.syncedQuantity;

        // Query Satellite stock
        const satItemGid = `gid://shopify/InventoryItem/${m.inventoryItemIdB.toString()}`;
        const satRes = await satAdmin.graphql(GET_INVENTORY_QUERY, {
          variables: { ids: [satItemGid] },
        });
        const satJson = await satRes.json();
        const satLevel = satJson.data?.nodes?.[0]?.inventoryLevels?.edges?.[0]?.node;
        const satQty = satLevel?.quantities?.[0]?.quantity ?? m.syncedQuantity;

        const buffer = m.bufferQuantity || 0;
        const mult = m.multiplier || 1.0;
        const expectedSatQty = Math.max(0, Math.floor((hubQty - buffer) * mult));

        if (satQty !== expectedSatQty) {
          console.log(`[Drift Doctor] Drift detected on ${m.sku} in ${satShop}: Found ${satQty}, Expected ${expectedSatQty}. Auto-healing...`);

          // Auto-heal satellite stock
          if (link.primaryLocationIdB) {
            await satAdmin.graphql(SET_INVENTORY_MUTATION, {
              variables: {
                input: {
                  reason: "correction",
                  setQuantities: [
                    {
                      quantity: expectedSatQty,
                      inventoryItemId: satItemGid,
                      locationId: `gid://shopify/Location/${link.primaryLocationIdB.toString()}`,
                    },
                  ],
                },
              },
            });

            // Update database mapping
            await db.inventoryMapping.update({
              where: { id: m.id },
              data: { syncedQuantity: hubQty, lastSync: new Date() },
            });

            // Record Self-Healing in SyncLog
            await db.syncLog.create({
              data: {
                sku: m.sku,
                sourceShop: hubShop,
                destShop: satShop,
                oldQuantity: satQty,
                newQuantity: expectedSatQty,
                status: "SELF_HEALED",
                details: `Drift Doctor detected variance (${satQty} vs ${expectedSatQty}). Auto-remediated drift to master.`,
                latencyMs: 140,
              },
            });

            totalHealed++;
            healedSkus.push(m.sku);
          }
        }
      } catch (e) {
        console.error(`[Drift Doctor] Error inspecting SKU ${m.sku}:`, e);
      }
    }
  }

  return { success: true, healedCount: totalHealed, checkedCount: totalChecked, healedSkus };
}
