import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { executeEmergencyRollback } from "../inventory-sync.server";
import { getFuzzyMatchSuggestions, autoCloneCatalogToSatellite } from "../smart-matcher.server";
import { syncWholesalePricing } from "../pricing-sync.server";
import { runDriftDoctor } from "../drift-doctor.server";
import { forwardOrderToHub } from "../order-routing.server";

const GET_PRODUCTS_QUERY = `#graphql
  query getProductsWithVariants {
    products(first: 100) {
      edges {
        node {
          title
          variants(first: 50) {
            edges {
              node {
                id
                sku
                title
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

const GET_LOCATIONS_QUERY = `#graphql
  query getLocations {
    locations(first: 10) {
      edges {
        node {
          id
          name
          isPrimary
          isActive
        }
      }
    }
  }
`;

const GET_SUBSCRIPTIONS_QUERY = `#graphql
  query getAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        currentPeriodEnd
      }
    }
  }
`;

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
      userErrors {
        field
        message
      }
      confirmationUrl
      appSubscription {
        id
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin: currentAdmin } = await authenticate.admin(request);
  const shop = session.shop;
  const clientId = process.env.SHOPIFY_API_KEY || "790628a610ddb04ef53f725df31fdfef";

  // Check subscription status
  let plan = "Free Tier";
  let isPro = false;
  try {
    const subRes = await currentAdmin.graphql(GET_SUBSCRIPTIONS_QUERY);
    const subJson = await subRes.json();
    const activeSub = subJson.data?.currentAppInstallation?.activeSubscriptions?.[0];
    if (activeSub && activeSub.status === "ACTIVE") {
      plan = activeSub.name;
      isPro = true;
    }
  } catch (e) {
    console.warn("Could not check subscription:", e);
  }

  // 1. Check if this store is a Satellite Store
  const satelliteLink = await db.connectedStore.findFirst({
    where: { shopDomainB: shop },
  });

  if (satelliteLink) {
    const hubShop = satelliteLink.shopDomainA;
    let locationName = "Shop Location";

    try {
      const locRes = await currentAdmin.graphql(GET_LOCATIONS_QUERY);
      const locData = await locRes.json();
      const locs = locData.data?.locations?.edges || [];
      const primaryLoc = locs.find((l: any) => l.node.isPrimary) || locs[0];
      if (primaryLoc) {
        locationName = primaryLoc.node.name;
        if (!satelliteLink.primaryLocationIdB) {
          await db.connectedStore.update({
            where: { id: satelliteLink.id },
            data: { primaryLocationIdB: BigInt(primaryLoc.node.id.split("/").pop()) },
          });
        }
      }
    } catch (e) {
      console.warn("Could not resolve location for satellite store:", e);
    }

    const mappings = await db.inventoryMapping.findMany({
      where: { storeGroupId: satelliteLink.id },
      orderBy: { lastSync: "desc" },
    });

    const recentLogs = await db.syncLog.findMany({
      where: { OR: [{ sourceShop: shop }, { destShop: shop }] },
      take: 15,
      orderBy: { createdAt: "desc" },
    });

    return {
      role: "satellite" as const,
      shop,
      hubShop,
      locationName,
      plan,
      isPro,
      circuitBreakerTripped: satelliteLink.circuitBreakerTripped,
      circuitBreakerReason: satelliteLink.circuitBreakerReason,
      mappings: mappings.map((m) => ({
        id: m.id,
        sku: m.sku,
        variantIdA: m.variantIdA.toString(),
        inventoryItemIdA: m.inventoryItemIdA.toString(),
        variantIdB: m.variantIdB.toString(),
        inventoryItemIdB: m.inventoryItemIdB.toString(),
        syncedQuantity: m.syncedQuantity,
        bufferQuantity: m.bufferQuantity,
        multiplier: m.multiplier,
        lastSync: m.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })),
      logs: recentLogs.map((l) => ({
        id: l.id,
        sku: l.sku,
        oldQuantity: l.oldQuantity,
        newQuantity: l.newQuantity,
        status: l.status,
        details: l.details,
        time: l.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })),
    };
  }

  // 2. Hub Store: Check all satellite stores connected to this Hub
  const hubLinks = await db.connectedStore.findMany({
    where: { shopDomainA: shop },
    include: { inventoryMappings: true },
  });

  if (hubLinks.length === 0) {
    return {
      role: "unconfigured" as const,
      shop,
      plan,
      isPro,
    };
  }

  // Auto-discover location for Primary Hub store
  let hubLocationName = "Main Location";
  try {
    const locRes = await currentAdmin.graphql(GET_LOCATIONS_QUERY);
    const locData = await locRes.json();
    const locs = locData.data?.locations?.edges || [];
    const primaryLoc = locs.find((l: any) => l.node.isPrimary) || locs[0];
    if (primaryLoc) {
      hubLocationName = primaryLoc.node.name;
      const hubLocId = BigInt(primaryLoc.node.id.split("/").pop());
      for (const link of hubLinks) {
        if (!link.primaryLocationIdA) {
          await db.connectedStore.update({
            where: { id: link.id },
            data: { primaryLocationIdA: hubLocId },
          });
        }
      }
    }
  } catch (e) {
    console.warn("Could not resolve Hub location:", e);
  }

  // Process all satellite stores connected to this Hub
  let circuitBreakerTripped = false;
  let circuitBreakerReason: string | null = null;
  let circuitBreakerThreshold = 70;

  const processedStores = await Promise.all(
    hubLinks.map(async (link) => {
      if (link.circuitBreakerTripped) {
        circuitBreakerTripped = true;
        circuitBreakerReason = link.circuitBreakerReason;
      }
      circuitBreakerThreshold = link.circuitBreakerThreshold || 70;

      const storeB = link.shopDomainB;
      const sessionB = await db.session.findFirst({
        where: { shop: storeB, isOnline: false },
      });

      let locationName = "Shop Location";
      let status: "active" | "pending_auth" = sessionB ? "active" : "pending_auth";

      if (sessionB) {
        try {
          const { admin: adminB } = await unauthenticated.admin(storeB);
          const locResB = await adminB.graphql(GET_LOCATIONS_QUERY);
          const locDataB = await locResB.json();
          const locsB = locDataB.data?.locations?.edges || [];
          const primaryB = locsB.find((l: any) => l.node.isPrimary) || locsB[0];
          if (primaryB) {
            locationName = primaryB.node.name;
            if (!link.primaryLocationIdB) {
              await db.connectedStore.update({
                where: { id: link.id },
                data: { primaryLocationIdB: BigInt(primaryB.node.id.split("/").pop()) },
              });
            }
          }
        } catch (e) {
          console.warn(`Could not resolve location for ${storeB}:`, e);
        }
      }

      const storeBHandle = storeB.replace(".myshopify.com", "");
      const authUrl = `https://admin.shopify.com/store/${storeBHandle}/oauth/install?client_id=${clientId}`;

      return {
        id: link.id,
        shopDomain: storeB,
        locationName,
        status,
        authUrl,
        mappedCount: link.inventoryMappings.length,
        priceMultiplier: link.priceMultiplier,
        priceOffset: link.priceOffset,
        speedSurgeMode: link.speedSurgeMode,
        autoHealDrift: link.autoHealDrift,
        orderForwardingEnabled: link.orderForwardingEnabled,
      };
    })
  );

  // Collect mapped items
  const allMappings = await db.inventoryMapping.findMany({
    where: { storeGroupId: { in: hubLinks.map((l) => l.id) } },
    include: { storeGroup: true },
    orderBy: { lastSync: "desc" },
  });

  const skuMap = new Map<string, { id: number; sku: string; quantity: number; bufferQuantity: number; multiplier: number; stores: string[]; lastSync: string }>();
  let totalNetworkUnits = 0;
  let lowStockCount = 0;

  allMappings.forEach((m) => {
    totalNetworkUnits += m.syncedQuantity;
    if (m.syncedQuantity <= 5) lowStockCount++;

    if (!skuMap.has(m.sku)) {
      skuMap.set(m.sku, {
        id: m.id,
        sku: m.sku,
        quantity: m.syncedQuantity,
        bufferQuantity: m.bufferQuantity,
        multiplier: m.multiplier,
        stores: [m.storeGroup.shopDomainB],
        lastSync: m.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
    } else {
      const entry = skuMap.get(m.sku)!;
      if (!entry.stores.includes(m.storeGroup.shopDomainB)) {
        entry.stores.push(m.storeGroup.shopDomainB);
      }
    }
  });

  // Recent sync audit logs
  const recentLogs = await db.syncLog.findMany({
    take: 25,
    orderBy: { createdAt: "desc" },
  });

  // Average latency
  const avgLatency = recentLogs.length > 0
    ? Math.round(recentLogs.reduce((acc, l) => acc + (l.latencyMs || 450), 0) / recentLogs.length)
    : 380;

  // Forwarded orders
  const forwardedOrders = await db.forwardedOrder.findMany({
    where: { hubShop: shop },
    take: 15,
    orderBy: { createdAt: "desc" },
  });

  // Monthly performance tracking (Syncio-style performance tiers)
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const monthlySyncedOrdersCount = await db.forwardedOrder.count({
    where: {
      hubShop: shop,
      createdAt: { gte: startOfMonth },
    },
  });

  // Calculate current performance tier
  let performanceTier = "Free";
  let tierCost = "$0/mo";
  let tierOrderLimit = 25;
  let nextTier = "Starter ($9/mo)";
  if (monthlySyncedOrdersCount > 1500) {
    performanceTier = "Enterprise";
    tierCost = "$59/mo";
    tierOrderLimit = 10000;
    nextTier = "Custom High Volume";
  } else if (monthlySyncedOrdersCount > 150) {
    performanceTier = "Pro Growth";
    tierCost = "$29/mo";
    tierOrderLimit = 1500;
    nextTier = "Enterprise ($59/mo)";
  } else if (monthlySyncedOrdersCount > 25) {
    performanceTier = "Starter";
    tierCost = "$9/mo";
    tierOrderLimit = 150;
    nextTier = "Pro Growth ($29/mo)";
  }

  const isSpeedSurgeActive = hubLinks.some((l) => l.speedSurgeMode);

  return {
    role: "hub" as const,
    shop,
    hubLocationName,
    plan,
    isPro,
    connectedStores: processedStores,
    totalMappings: skuMap.size,
    mappings: Array.from(skuMap.values()),
    totalNetworkUnits,
    lowStockCount,
    avgLatency,
    circuitBreakerTripped,
    circuitBreakerReason,
    circuitBreakerThreshold,
    isSpeedSurgeActive,
    monthlySyncedOrdersCount,
    performanceTier,
    tierCost,
    tierOrderLimit,
    nextTier,
    forwardedOrders: forwardedOrders.map((o) => ({
      id: o.id,
      satelliteShop: o.satelliteShop,
      orderNumber: o.orderNumber,
      customerEmail: o.customerEmail,
      totalPrice: o.totalPrice,
      itemCount: o.itemCount,
      status: o.status,
      time: o.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })),
    logs: recentLogs.map((l) => ({
      id: l.id,
      sku: l.sku,
      sourceShop: l.sourceShop,
      destShop: l.destShop,
      oldQuantity: l.oldQuantity,
      newQuantity: l.newQuantity,
      status: l.status,
      details: l.details,
      latencyMs: l.latencyMs || 420,
      time: l.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin: currentAdmin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action");

  // 1. Upgrade to Pro Subscription via Shopify Billing API
  if (actionType === "upgradePlan") {
    const returnUrl = `https://${new URL(request.url).host}/app`;
    const response = await currentAdmin.graphql(CREATE_SUBSCRIPTION_MUTATION, {
      variables: {
        name: "GhostSync Pro",
        returnUrl,
        test: true,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: {
                  amount: 19.0,
                  currencyCode: "USD",
                },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    });

    const responseJson = await response.json();
    const confirmationUrl = responseJson.data?.appSubscriptionCreate?.confirmationUrl;
    if (confirmationUrl) {
      return { confirmationUrl };
    }
    return { error: "Failed to generate subscription URL." };
  }

  // 2. Connect Store
  if (actionType === "connectStore") {
    let storeBDomain = ((formData.get("storeBDomain") as string) || "").trim();
    if (!storeBDomain.includes(".myshopify.com")) {
      storeBDomain = `${storeBDomain}.myshopify.com`;
    }

    const existing = await db.connectedStore.findFirst({
      where: {
        shopDomainA: session.shop,
        shopDomainB: storeBDomain,
      },
    });

    if (!existing) {
      await db.connectedStore.create({
        data: {
          shopDomainA: session.shop,
          shopDomainB: storeBDomain,
          accessTokenA: session.accessToken || "",
          accessTokenB: "",
        },
      });
    }

    const clientId = process.env.SHOPIFY_API_KEY || "790628a610ddb04ef53f725df31fdfef";
    const storeBHandle = storeBDomain.replace(".myshopify.com", "");
    const authUrl = `https://admin.shopify.com/store/${storeBHandle}/oauth/install?client_id=${clientId}`;

    return { success: true, addedStore: storeBDomain, authUrl };
  }

  // 3. Disconnect Store
  if (actionType === "disconnectStore") {
    const storeId = Number(formData.get("storeId"));
    if (storeId) {
      await db.connectedStore.deleteMany({
        where: { id: storeId, shopDomainA: session.shop },
      });
      return { success: true, disconnected: true };
    }
    return { success: false, error: "Missing store ID" };
  }

  // 4. Update SKU Rule (Buffer & Multiplier)
  if (actionType === "updateRule") {
    const sku = formData.get("sku") as string;
    const bufferQuantity = parseInt(formData.get("bufferQuantity") as string, 10) || 0;
    const multiplier = parseFloat(formData.get("multiplier") as string) || 1.0;

    await db.inventoryMapping.updateMany({
      where: {
        sku,
        storeGroup: { shopDomainA: session.shop },
      },
      data: {
        bufferQuantity,
        multiplier,
      },
    });

    return { success: true, updatedRule: sku, bufferQuantity, multiplier };
  }

  // 5. Emergency Rollback & Reset Circuit Breaker
  if (actionType === "emergencyRollback") {
    try {
      const res = await executeEmergencyRollback(session.shop);
      return { success: true, rolledBack: true, restoredCount: res.restoredCount };
    } catch (e: any) {
      return { success: false, error: e.message || "Rollback failed." };
    }
  }

  // 6. Arm / Reset Circuit Breaker Manually
  if (actionType === "resetCircuitBreaker") {
    await db.connectedStore.updateMany({
      where: { shopDomainA: session.shop },
      data: { circuitBreakerTripped: false, circuitBreakerReason: null },
    });
    return { success: true, circuitBreakerReset: true };
  }

  // 7. Update Circuit Breaker Threshold
  if (actionType === "updateCircuitBreakerThreshold") {
    const threshold = parseInt(formData.get("threshold") as string, 10) || 70;
    await db.connectedStore.updateMany({
      where: { shopDomainA: session.shop },
      data: { circuitBreakerThreshold: threshold },
    });
    return { success: true, updatedThreshold: threshold };
  }

  // 8. Scan Fuzzy Match Suggestions
  if (actionType === "scanFuzzyMatches") {
    const hubLinks = await db.connectedStore.findMany({
      where: { shopDomainA: session.shop },
    });
    if (hubLinks.length === 0) return { fuzzySuggestions: [] };

    const suggestions = [];
    for (const link of hubLinks) {
      try {
        const res = await getFuzzyMatchSuggestions(session.shop, link.shopDomainB, link.id);
        suggestions.push(...res);
      } catch (e) {
        console.error("Fuzzy scan error:", e);
      }
    }
    return { success: true, fuzzySuggestions: suggestions };
  }

  // 9. Approve Fuzzy Match Link
  if (actionType === "approveFuzzyMatch") {
    const storeGroupId = parseInt(formData.get("storeGroupId") as string, 10);
    const skuA = formData.get("skuA") as string;
    const varIdA = formData.get("varIdA") as string;
    const invItemIdA = formData.get("invItemIdA") as string;
    const varIdB = formData.get("varIdB") as string;
    const invItemIdB = formData.get("invItemIdB") as string;
    const qtyA = parseInt(formData.get("qtyA") as string, 10) || 0;

    await db.inventoryMapping.create({
      data: {
        storeGroupId,
        sku: skuA,
        variantIdA: BigInt(varIdA.split("/").pop()!),
        inventoryItemIdA: BigInt(invItemIdA.split("/").pop()!),
        variantIdB: BigInt(varIdB.split("/").pop()!),
        inventoryItemIdB: BigInt(invItemIdB.split("/").pop()!),
        syncedQuantity: qtyA,
      },
    });

    return { success: true, approvedFuzzySku: skuA };
  }

  // 10. 1-Click Catalog Auto-Clone / Push to Satellite
  if (actionType === "cloneCatalogToSatellite") {
    const hubLinks = await db.connectedStore.findMany({
      where: { shopDomainA: session.shop },
    });
    if (hubLinks.length === 0) return { error: "No satellite stores connected." };

    let totalCloned = 0;
    for (const link of hubLinks) {
      try {
        const res = await autoCloneCatalogToSatellite(session.shop, link.shopDomainB, link.id);
        totalCloned += res.clonedCount;
      } catch (e: any) {
        console.error("Clone catalog error:", e);
      }
    }

    return { success: true, clonedCatalogCount: totalCloned };
  }

  // 11. Scan Stock Discrepancies
  if (actionType === "scanDiscrepancies") {
    const hubLinks = await db.connectedStore.findMany({
      where: { shopDomainA: session.shop },
      include: { inventoryMappings: true },
    });

    const discrepancies: { sku: string; shopA: string; shopB: string; qtyA: number; qtyB: number; diff: number }[] = [];

    // Fetch Store A products
    const resA = await currentAdmin.graphql(GET_PRODUCTS_QUERY);
    const dataA = await resA.json();
    const stockMapA = new Map<string, number>();
    dataA.data?.products?.edges?.forEach((p: any) => {
      p.node.variants?.edges?.forEach((v: any) => {
        if (v.node.sku) stockMapA.set(v.node.sku.trim(), v.node.inventoryQuantity ?? 0);
      });
    });

    for (const link of hubLinks) {
      const satShop = link.shopDomainB;
      const satSession = await db.session.findFirst({ where: { shop: satShop, isOnline: false } });
      if (!satSession) continue;

      try {
        const { admin: satAdmin } = await unauthenticated.admin(satShop);
        const resB = await satAdmin.graphql(GET_PRODUCTS_QUERY);
        const dataB = await resB.json();

        dataB.data?.products?.edges?.forEach((p: any) => {
          p.node.variants?.edges?.forEach((v: any) => {
            if (v.node.sku) {
              const sku = v.node.sku.trim();
              const qtyA = stockMapA.get(sku);
              const qtyB = v.node.inventoryQuantity ?? 0;
              if (qtyA !== undefined && qtyA !== qtyB) {
                discrepancies.push({
                  sku,
                  shopA: session.shop,
                  shopB: satShop,
                  qtyA,
                  qtyB,
                  diff: qtyA - qtyB,
                });
              }
            }
          });
        });
      } catch (e) {
        console.error("Discrepancy scan error for " + satShop, e);
      }
    }

    return { success: true, scannedDiscrepancies: discrepancies };
  }

  // 12. Multi-Store AutoMap
  if (actionType === "autoMap") {
    const isSatellite = await db.connectedStore.findFirst({
      where: { shopDomainB: session.shop },
    });
    const hubShop = isSatellite ? isSatellite.shopDomainA : session.shop;
    const hubLinks = await db.connectedStore.findMany({ where: { shopDomainA: hubShop } });

    if (hubLinks.length === 0) {
      return { success: false, error: "No stores connected." };
    }

    try {
      const hubAdmin = !isSatellite ? currentAdmin : (await unauthenticated.admin(hubShop)).admin;
      const responseA = await hubAdmin.graphql(GET_PRODUCTS_QUERY);
      const dataA = await responseA.json();

      const variantsA: { sku: string; variantId: string; inventoryItemId: string; quantity: number }[] = [];
      dataA.data?.products?.edges?.forEach((p: any) => {
        p.node.variants?.edges?.forEach((v: any) => {
          if (v.node.sku) {
            variantsA.push({
              sku: v.node.sku.trim(),
              variantId: v.node.id.split("/").pop(),
              inventoryItemId: v.node.inventoryItem?.id?.split("/").pop(),
              quantity: v.node.inventoryQuantity ?? 0,
            });
          }
        });
      });

      let totalMapped = 0;

      for (const link of hubLinks) {
        const satShop = link.shopDomainB;
        const satSession = await db.session.findFirst({ where: { shop: satShop, isOnline: false } });
        if (!satSession) continue;

        const { admin: satAdmin } = satShop === session.shop ? { admin: currentAdmin } : await unauthenticated.admin(satShop);
        const responseB = await satAdmin.graphql(GET_PRODUCTS_QUERY);
        const dataB = await responseB.json();

        const mapB = new Map<string, { variantId: string; inventoryItemId: string }>();
        dataB.data?.products?.edges?.forEach((p: any) => {
          p.node.variants?.edges?.forEach((v: any) => {
            if (v.node.sku) {
              mapB.set(v.node.sku.trim(), {
                variantId: v.node.id.split("/").pop(),
                inventoryItemId: v.node.inventoryItem?.id?.split("/").pop(),
              });
            }
          });
        });

        for (const itemA of variantsA) {
          const itemB = mapB.get(itemA.sku);
          if (itemB && itemA.inventoryItemId && itemB.inventoryItemId) {
            await db.inventoryMapping.deleteMany({
              where: { storeGroupId: link.id, sku: itemA.sku },
            });

            await db.inventoryMapping.create({
              data: {
                storeGroupId: link.id,
                sku: itemA.sku,
                variantIdA: BigInt(itemA.variantId),
                inventoryItemIdA: BigInt(itemA.inventoryItemId),
                variantIdB: BigInt(itemB.variantId),
                inventoryItemIdB: BigInt(itemB.inventoryItemId),
                isSyncing: false,
                syncedQuantity: itemA.quantity,
              },
            });
            totalMapped++;
          }
        }
      }

      return { success: true, mapped: totalMapped };
    } catch (e: any) {
      console.error("Error in autoMap:", e);
      return { success: false, error: e.message || "Failed to scan products." };
    }
  }

  // 13. Sync Wholesale Pricing
  if (actionType === "syncWholesalePricing") {
    const storeGroupId = parseInt(formData.get("storeGroupId") as string, 10);
    try {
      const res = await syncWholesalePricing(storeGroupId);
      return { success: true, pricingSynced: true, updatedCount: res.updatedCount };
    } catch (e: any) {
      return { success: false, error: e.message || "Pricing sync failed." };
    }
  }

  // 14. Update Store Pricing & Routing Settings
  if (actionType === "updateStoreSettings") {
    const storeGroupId = parseInt(formData.get("storeGroupId") as string, 10);
    const priceMultiplier = parseFloat(formData.get("priceMultiplier") as string) || 1.0;
    const priceOffset = parseFloat(formData.get("priceOffset") as string) || 0.0;
    const orderForwarding = formData.get("orderForwardingEnabled") === "true";

    await db.connectedStore.update({
      where: { id: storeGroupId },
      data: {
        priceMultiplier,
        priceOffset,
        orderForwardingEnabled: orderForwarding,
      },
    });

    return { success: true, settingsUpdated: true };
  }

  // 15. Toggle Speed Surge Mode (Flash Sale / BFCM)
  if (actionType === "toggleSpeedSurge") {
    const currentState = formData.get("currentState") === "true";
    const newState = !currentState;

    await db.connectedStore.updateMany({
      where: { shopDomainA: session.shop },
      data: { speedSurgeMode: newState },
    });

    return { success: true, speedSurgeMode: newState };
  }

  // 16. Trigger Drift Doctor Automated Healing
  if (actionType === "triggerDriftDoctor") {
    try {
      const res = await runDriftDoctor(session.shop);
      return { success: true, driftDoctorResult: res };
    } catch (e: any) {
      return { success: false, error: e.message || "Drift Doctor check failed." };
    }
  }

  // 17. Simulate Cross-Store Order Forwarding Test
  if (actionType === "simulateOrderForward") {
    const hubLink = await db.connectedStore.findFirst({
      where: { shopDomainA: session.shop },
    });
    if (!hubLink) return { error: "No satellite store connected." };

    try {
      const fakeOrder = {
        id: Math.floor(Math.random() * 900000) + 100000,
        name: `#SAT-${Math.floor(Math.random() * 9000) + 1000}`,
        total_price: "89.50",
        email: "wholesale-buyer@enterprise.com",
        line_items: [
          {
            title: "Test Hoodie - Black",
            sku: "GHOST",
            price: "89.50",
            quantity: 2,
          },
        ],
      };

      const res = await forwardOrderToHub({
        satelliteShop: hubLink.shopDomainB,
        orderPayload: fakeOrder,
      });

      return { success: true, orderForwarded: true, orderNumber: fakeOrder.name };
    } catch (e: any) {
      return { success: false, error: e.message || "Order forwarding failed." };
    }
  }

  return null;
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [activeTab, setActiveTab] = useState<"network" | "skus" | "wholesale" | "orders" | "smartMatch" | "scanner" | "logs" | "pricing">("network");
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [bufferInput, setBufferInput] = useState("0");
  const [multiplierInput, setMultiplierInput] = useState("1.0");
  const [editingStoreSettings, setEditingStoreSettings] = useState<number | null>(null);
  const [priceMultiplierInput, setPriceMultiplierInput] = useState("1.0");
  const [priceOffsetInput, setPriceOffsetInput] = useState("0.0");
  const [orderForwardingInput, setOrderForwardingInput] = useState(true);

  useEffect(() => {
    if (fetcher.data) {
      if ("mapped" in fetcher.data && fetcher.data.mapped !== undefined) {
        shopify.toast.show(`Synced ${fetcher.data.mapped} SKUs across network!`);
      } else if ("confirmationUrl" in fetcher.data && fetcher.data.confirmationUrl) {
        if ((shopify as any)?.open) {
          (shopify as any).open(fetcher.data.confirmationUrl as string, "_top");
        } else {
          window.open(fetcher.data.confirmationUrl as string, "_top");
        }
      } else if ("updatedRule" in fetcher.data) {
        shopify.toast.show(`Updated rule for ${fetcher.data.updatedRule}!`);
        setEditingSku(null);
      } else if ("rolledBack" in fetcher.data) {
        shopify.toast.show(`Emergency Rollback complete! Restored inventory.`);
      } else if ("circuitBreakerReset" in fetcher.data) {
        shopify.toast.show(`Circuit Breaker armed & re-enabled!`);
      } else if ("clonedCatalogCount" in fetcher.data) {
        shopify.toast.show(`Cloned ${fetcher.data.clonedCatalogCount} products & synced to satellite!`);
      } else if ("approvedFuzzySku" in fetcher.data) {
        shopify.toast.show(`Smart Match confirmed for SKU ${fetcher.data.approvedFuzzySku}!`);
      } else if ("disconnected" in fetcher.data) {
        shopify.toast.show("Store disconnected.");
      } else if ("addedStore" in fetcher.data) {
        shopify.toast.show(`Store ${fetcher.data.addedStore} registered!`);
      } else if ("pricingSynced" in fetcher.data) {
        shopify.toast.show(`Updated wholesale prices for ${fetcher.data.updatedCount} variants!`);
      } else if ("speedSurgeMode" in fetcher.data) {
        shopify.toast.show(fetcher.data.speedSurgeMode ? "⚡ Speed Surge Mode ACTIVATED!" : "Speed Surge Mode deactivated.");
      } else if ("driftDoctorResult" in fetcher.data) {
        const res = fetcher.data.driftDoctorResult as any;
        shopify.toast.show(`Drift Doctor healed ${res.healedCount} of ${res.checkedCount} SKUs!`);
      } else if ("orderForwarded" in fetcher.data) {
        shopify.toast.show(`Shadow order mirrored to Hub: ${fetcher.data.orderNumber}`);
      } else if ("settingsUpdated" in fetcher.data) {
        shopify.toast.show("Store pricing & routing rules saved!");
      } else if ("error" in fetcher.data && fetcher.data.error) {
        shopify.toast.show(fetcher.data.error as string, { isError: true });
      }
    }
  }, [fetcher.data, shopify]);

  const isLoading = ["loading", "submitting"].includes(fetcher.state);

  // 1. Unconfigured View
  if (data.role === "unconfigured") {
    const authUrl = fetcher.data && "authUrl" in fetcher.data ? (fetcher.data.authUrl as string) : null;
    const addedStore = fetcher.data && "addedStore" in fetcher.data ? (fetcher.data.addedStore as string) : null;

    return (
      <div style={{ maxWidth: "800px", margin: "40px auto", padding: "0 20px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }}>
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "32px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <div style={{ background: "#f1f2f4", borderRadius: "8px", width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px" }}>👻</div>
            <div>
              <h1 style={{ fontSize: "20px", fontWeight: "600", margin: "0 0 4px 0", color: "#202223" }}>GhostSync: Multi-Store Inventory</h1>
              <p style={{ margin: 0, fontSize: "14px", color: "#6d7175" }}>Automated, real-time bidirectional inventory synchronization between your Shopify stores.</p>
            </div>
          </div>
          <hr style={{ border: "none", borderTop: "1px solid #e1e3e5", margin: "24px 0" }} />
          <h2 style={{ fontSize: "16px", fontWeight: "600", marginBottom: "8px" }}>Connect your first satellite store</h2>
          <p style={{ fontSize: "14px", color: "#6d7175", marginBottom: "20px" }}>Enter your secondary store domain to initialize your multi-store synchronization network.</p>

          {authUrl ? (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <span style={{ color: "#166534", fontWeight: "600", fontSize: "14px" }}>✓ Store registered ({addedStore}). Click below to authorize:</span>
              <button
                type="button"
                onClick={() => window.open(authUrl, "_blank")}
                style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "10px 20px", fontWeight: "600", fontSize: "14px", cursor: "pointer", alignSelf: "flex-start" }}
              >
                Authorize New Store →
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const formData = new FormData(form);
                fetcher.submit(formData, { method: "post" });
              }}
              style={{ display: "flex", gap: "12px", maxWidth: "540px" }}
            >
              <input type="hidden" name="action" value="connectStore" />
              <input
                type="text"
                name="storeBDomain"
                placeholder="secondary-store.myshopify.com"
                required
                style={{ flex: 1, padding: "10px 14px", borderRadius: "6px", border: "1px solid #d2d5d8", fontSize: "14px" }}
              />
              <button
                type="submit"
                disabled={isLoading}
                style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "10px 20px", fontWeight: "600", fontSize: "14px", cursor: "pointer" }}
              >
                {isLoading ? "Connecting..." : "Connect"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // 2. Dedicated Satellite View (Store B)
  if (data.role === "satellite") {
    const mappings = data.mappings || [];
    const logs = data.logs || [];

    return (
      <div style={{ maxWidth: "1000px", margin: "40px auto", padding: "0 24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }}>
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "24px", marginBottom: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ background: "#e4f8f0", borderRadius: "8px", width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px" }}>📡</div>
              <div>
                <h1 style={{ fontSize: "18px", fontWeight: "700", margin: "0 0 4px 0", color: "#202223" }}>GhostSync Satellite Node</h1>
                <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>Linked to Primary Master: <strong>{data.hubShop}</strong></p>
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                type="button"
                onClick={() => fetcher.submit({ action: "autoMap" }, { method: "post" })}
                disabled={isLoading}
                style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
              >
                {isLoading ? "Syncing..." : "⚡ Sync Matching SKUs"}
              </button>
            </div>
          </div>
        </div>

        {/* Satellite Inventory Mappings */}
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", overflow: "hidden", marginBottom: "24px" }}>
          <div style={{ padding: "18px 24px", borderBottom: "1px solid #e1e3e5" }}>
            <h2 style={{ fontSize: "15px", fontWeight: "600", margin: 0 }}>Active Synchronized SKUs ({mappings.length})</h2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                <th style={{ padding: "10px 24px" }}>SKU</th>
                <th style={{ padding: "10px 24px" }}>Synced Stock</th>
                <th style={{ padding: "10px 24px" }}>Buffer Applied</th>
                <th style={{ padding: "10px 24px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m: any) => (
                <tr key={m.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "14px 24px", fontWeight: "600" }}>{m.sku}</td>
                  <td style={{ padding: "14px 24px", fontWeight: "700" }}>{m.syncedQuantity} units</td>
                  <td style={{ padding: "14px 24px", color: m.bufferQuantity > 0 ? "#b95000" : "#6d7175" }}>
                    {m.bufferQuantity > 0 ? `-${m.bufferQuantity} units reserve` : "Direct 1:1"}
                  </td>
                  <td style={{ padding: "14px 24px" }}>
                    <span style={{ background: "#e4f8f0", color: "#108043", padding: "3px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700" }}>✓ In Sync</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 3. Primary Hub View (Store A)
  const connectedStores = data.connectedStores || [];
  const mappings = data.mappings || [];
  const logs = data.logs || [];
  const authUrl = fetcher.data && "authUrl" in fetcher.data ? (fetcher.data.authUrl as string) : null;
  const addedStore = fetcher.data && "addedStore" in fetcher.data ? (fetcher.data.addedStore as string) : null;
  const discrepancies = fetcher.data && "scannedDiscrepancies" in fetcher.data ? (fetcher.data.scannedDiscrepancies as any[]) : null;
  const fuzzySuggestions = fetcher.data && "fuzzySuggestions" in fetcher.data ? (fetcher.data.fuzzySuggestions as any[]) : null;

  return (
    <div style={{ maxWidth: "1140px", margin: "24px auto", padding: "0 24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }}>

      {/* EMERGENCY CIRCUIT BREAKER ALERT BANNER */}
      {data.circuitBreakerTripped && (
        <div style={{
          background: "linear-gradient(135deg, #450a0a 0%, #1c0505 100%)",
          border: "2px solid #ef4444",
          borderRadius: "12px",
          padding: "20px 24px",
          marginBottom: "24px",
          boxShadow: "0 10px 25px rgba(239, 68, 68, 0.25)",
          color: "#ffffff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "20px" }}>🚨</span>
              <span style={{ fontSize: "16px", fontWeight: "800", letterSpacing: "0.5px", color: "#fca5a5" }}>
                CIRCUIT BREAKER TRIPPED — NETWORK SYNC PAUSED
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "#fecaca", maxWidth: "680px", lineHeight: "1.4" }}>
              {data.circuitBreakerReason || "A rapid stock drop was detected exceeding your safety threshold. Sync fanout was halted to protect your secondary stores."}
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "emergencyRollback" }, { method: "post" })}
              disabled={isLoading}
              style={{
                background: "#ef4444",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "10px 18px",
                fontWeight: "700",
                fontSize: "13px",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(239, 68, 68, 0.4)",
              }}
            >
              🔄 1-Click Emergency Rollback
            </button>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "resetCircuitBreaker" }, { method: "post" })}
              disabled={isLoading}
              style={{
                background: "rgba(255, 255, 255, 0.15)",
                color: "#ffffff",
                border: "1px solid rgba(255, 255, 255, 0.3)",
                borderRadius: "6px",
                padding: "10px 16px",
                fontWeight: "600",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Dismiss & Re-arm
            </button>
          </div>
        </div>
      )}

      {/* TOP HEADER: BRANDING, STATUS & BILLING */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            background: "linear-gradient(135deg, #09090b 0%, #27272a 100%)",
            color: "#ffffff",
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
          }}>
            👻
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "18px", fontWeight: "800", color: "#09090b", letterSpacing: "-0.3px" }}>GhostSync Network Hub</span>
              <span style={{
                background: data.performanceTier === "Free" ? "#e4e5e7" : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                color: data.performanceTier === "Free" ? "#202223" : "#ffffff",
                border: "none",
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "10px",
                fontWeight: "800",
                letterSpacing: "0.5px",
                textTransform: "uppercase",
              }}>
                {data.performanceTier.toUpperCase()} TIER ({data.tierCost})
              </span>
            </div>
            <span style={{ fontSize: "12px", color: "#71717a" }}>
              {data.monthlySyncedOrdersCount || 0} / {data.tierOrderLimit} Synced Orders This Month &bull; Next: {data.nextTier}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            type="button"
            onClick={() => setActiveTab("pricing")}
            style={{
              background: "#f4f4f5",
              color: "#18181b",
              border: "1px solid #d4d4d8",
              borderRadius: "8px",
              padding: "8px 14px",
              fontWeight: "600",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            📊 View Performance Tiers
          </button>
        </div>
      </div>

      {/* "SYNC RADAR" & TELEMETRY HUD (NEW SLEEK HERO COMPONENT) */}
      <div style={{
        background: "linear-gradient(135deg, #09090b 0%, #18181b 100%)",
        borderRadius: "16px",
        padding: "24px 28px",
        marginBottom: "24px",
        boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
        color: "#ffffff",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Subtle grid pattern background */}
        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0)",
          backgroundSize: "24px 24px",
          pointerEvents: "none",
        }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "20px", position: "relative", zIndex: 1 }}>
          {/* Visual Topology Radar Visualizer */}
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {/* Primary Hub Node */}
            <div style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "12px",
              padding: "12px 18px",
              textAlign: "center",
              backdropFilter: "blur(8px)",
            }}>
              <div style={{ fontSize: "10px", color: "#a1a1aa", fontWeight: "700", textTransform: "uppercase", letterSpacing: "1px" }}>Primary Master</div>
              <div style={{ fontSize: "14px", fontWeight: "800", color: "#ffffff", marginTop: "2px" }}>{data.shop.split(".")[0]}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", marginTop: "4px" }}>
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981", display: "inline-block", boxShadow: "0 0 8px #10b981" }} />
                <span style={{ fontSize: "11px", color: "#34d399", fontWeight: "600" }}>Master Hub</span>
              </div>
            </div>

            {/* Glowing animated bridge */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
              <div style={{ fontSize: "10px", color: "#10b981", fontWeight: "800", letterSpacing: "0.5px" }}>
                ⚡ {data.avgLatency}ms
              </div>
              <div style={{
                width: "60px",
                height: "2px",
                background: "linear-gradient(90deg, #10b981, #06b6d4, #10b981)",
                boxShadow: "0 0 10px rgba(16, 185, 129, 0.8)",
              }} />
              <div style={{ fontSize: "9px", color: "#71717a", textTransform: "uppercase" }}>Real-Time Fanout</div>
            </div>

            {/* Satellite Store Nodes */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {connectedStores.map((s: any) => (
                <div key={s.id} style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: "12px",
                  padding: "10px 14px",
                  textAlign: "center",
                }}>
                  <div style={{ fontSize: "9px", color: "#a1a1aa", textTransform: "uppercase" }}>Satellite Node</div>
                  <div style={{ fontSize: "13px", fontWeight: "700", color: "#f4f4f5", marginTop: "2px" }}>{s.shopDomain.split(".")[0]}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", marginTop: "3px" }}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: s.status === "active" ? "#10b981" : "#f59e0b" }} />
                    <span style={{ fontSize: "10px", color: s.status === "active" ? "#a7f3d0" : "#fde68a" }}>
                      {s.status === "active" ? "Active" : "Auth Pending"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* HUD Metric Chips */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <div style={{
              background: "rgba(255, 255, 255, 0.05)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "10px",
              padding: "10px 16px",
              minWidth: "110px",
            }}>
              <div style={{ fontSize: "11px", color: "#a1a1aa", fontWeight: "600" }}>Total Cluster Stock</div>
              <div style={{ fontSize: "20px", fontWeight: "800", color: "#ffffff", marginTop: "2px" }}>{data.totalNetworkUnits} <span style={{ fontSize: "12px", fontWeight: "500", color: "#71717a" }}>units</span></div>
            </div>

            <div style={{
              background: data.lowStockCount > 0 ? "rgba(239, 68, 68, 0.12)" : "rgba(255, 255, 255, 0.05)",
              border: data.lowStockCount > 0 ? "1px solid rgba(239, 68, 68, 0.3)" : "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "10px",
              padding: "10px 16px",
              minWidth: "110px",
            }}>
              <div style={{ fontSize: "11px", color: data.lowStockCount > 0 ? "#fca5a5" : "#a1a1aa", fontWeight: "600" }}>Depletion Alerts</div>
              <div style={{ fontSize: "20px", fontWeight: "800", color: data.lowStockCount > 0 ? "#ef4444" : "#ffffff", marginTop: "2px" }}>
                {data.lowStockCount} <span style={{ fontSize: "12px", fontWeight: "500", color: data.lowStockCount > 0 ? "#fca5a5" : "#71717a" }}>SKUs</span>
              </div>
            </div>

            <div style={{
              background: data.isSpeedSurgeActive ? "linear-gradient(135deg, #4f46e5 0%, #312e81 100%)" : "rgba(255, 255, 255, 0.05)",
              border: data.isSpeedSurgeActive ? "1px solid #818cf8" : "1px solid rgba(255, 255, 255, 0.1)",
              borderRadius: "10px",
              padding: "10px 16px",
              minWidth: "130px",
              boxShadow: data.isSpeedSurgeActive ? "0 0 15px rgba(99, 102, 241, 0.5)" : "none",
            }}>
              <div style={{ fontSize: "11px", color: data.isSpeedSurgeActive ? "#c7d2fe" : "#a1a1aa", fontWeight: "600" }}>Speed Surge (BFCM)</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "4px" }}>
                <span style={{ fontSize: "12px", fontWeight: "800", color: data.isSpeedSurgeActive ? "#ffffff" : "#d4d4d8" }}>
                  {data.isSpeedSurgeActive ? "⚡ ACTIVE" : "OFF"}
                </span>
                <button
                  type="button"
                  onClick={() => fetcher.submit({ action: "toggleSpeedSurge", currentState: data.isSpeedSurgeActive ? "true" : "false" }, { method: "post" })}
                  disabled={isLoading}
                  style={{
                    background: data.isSpeedSurgeActive ? "#22c55e" : "rgba(255, 255, 255, 0.15)",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "10px",
                    fontWeight: "700",
                    cursor: "pointer",
                  }}
                >
                  {data.isSpeedSurgeActive ? "Turn Off" : "⚡ Surge"}
                </button>
              </div>
            </div>

            <div style={{
              background: "rgba(16, 185, 129, 0.1)",
              border: "1px solid rgba(16, 185, 129, 0.25)",
              borderRadius: "10px",
              padding: "10px 16px",
              minWidth: "120px",
            }}>
              <div style={{ fontSize: "11px", color: "#6ee7b7", fontWeight: "600" }}>Circuit Breaker</div>
              <div style={{ fontSize: "14px", fontWeight: "800", color: "#ffffff", marginTop: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: data.circuitBreakerTripped ? "#ef4444" : "#10b981", boxShadow: data.circuitBreakerTripped ? "0 0 10px #ef4444" : "0 0 10px #10b981" }} />
                {data.circuitBreakerTripped ? "TRIPPED" : "ARMED (≥70%)"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* NAVIGATION TABS */}
      <div style={{ display: "flex", gap: "6px", borderBottom: "1px solid #e4e4e7", marginBottom: "20px", overflowX: "auto" }}>
        <button
          type="button"
          onClick={() => setActiveTab("network")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "network" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "network" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "network" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Stores & Network ({connectedStores.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("skus")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "skus" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "skus" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "skus" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          SKUs & Buffer Rules ({mappings.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("wholesale")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "wholesale" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "wholesale" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "wholesale" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          🏷 Wholesale Pricing Rules
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("orders")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "orders" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "orders" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "orders" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          📦 Order Routing ({data.forwardedOrders?.length || 0})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("smartMatch")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "smartMatch" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "smartMatch" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "smartMatch" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            whiteSpace: "nowrap",
          }}
        >
          <span>✨ Smart Match & Push</span>
          <span style={{ background: "#e0e7ff", color: "#4338ca", fontSize: "10px", fontWeight: "700", padding: "1px 5px", borderRadius: "8px" }}>AI</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("scanner")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "scanner" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "scanner" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "scanner" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          🩺 Drift Doctor & Scanner
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("logs")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "logs" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "logs" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "logs" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Sync Audit Log ({logs.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("pricing")}
          style={{
            padding: "10px 16px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "pricing" ? "2px solid #18181b" : "2px solid transparent",
            color: activeTab === "pricing" ? "#18181b" : "#71717a",
            fontWeight: activeTab === "pricing" ? "700" : "500",
            fontSize: "13px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            whiteSpace: "nowrap",
          }}
        >
          <span>💳 Performance Tiers</span>
          <span style={{ background: "#e0f2fe", color: "#0369a1", fontSize: "10px", fontWeight: "700", padding: "1px 6px", borderRadius: "8px" }}>
            {data.performanceTier}
          </span>
        </button>
      </div>

      {/* TAB 1: STORES & NETWORK */}
      {activeTab === "network" && (
        <>
          <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "20px 24px", marginBottom: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h2 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 4px 0" }}>Primary Hub: {data.shop}</h2>
                <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>📍 Location: {data.hubLocationName} • Central distribution node for real-time stock fanout.</p>
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => fetcher.submit({ action: "autoMap" }, { method: "post" })}
                  style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                >
                  {isLoading ? "Syncing Network..." : "⚡ Sync All Stores"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddModal(!showAddModal)}
                  style={{ background: "#ffffff", color: "#202223", border: "1px solid #d2d5d8", borderRadius: "6px", padding: "9px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                >
                  + Link Another Store
                </button>
              </div>
            </div>

            {/* Inline Add Store Form */}
            {(showAddModal || authUrl) && (
              <div style={{ marginTop: "20px", background: "#f8f9fa", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "20px" }}>
                <h3 style={{ fontSize: "14px", fontWeight: "600", margin: "0 0 8px 0" }}>Link a New Satellite Store</h3>
                <p style={{ fontSize: "13px", color: "#6d7175", margin: "0 0 16px 0" }}>Enter the Shopify domain of the store you want to add to this inventory cluster.</p>
                {authUrl ? (
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ color: "#166534", fontSize: "13px", fontWeight: "600" }}>✓ Store registered ({addedStore}). Click to authorize:</span>
                    <button
                      type="button"
                      onClick={() => window.open(authUrl, "_blank")}
                      style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "8px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                    >
                      Authorize New Store →
                    </button>
                  </div>
                ) : (
                  <fetcher.Form method="post" style={{ display: "flex", gap: "12px", maxWidth: "540px" }}>
                    <input type="hidden" name="action" value="connectStore" />
                    <input
                      type="text"
                      name="storeBDomain"
                      placeholder="test-store-three.myshopify.com"
                      required
                      style={{ flex: 1, padding: "8px 12px", borderRadius: "6px", border: "1px solid #d2d5d8", fontSize: "13px" }}
                    />
                    <button
                      type="submit"
                      disabled={isLoading}
                      style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "8px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                    >
                      Connect
                    </button>
                  </fetcher.Form>
                )}
              </div>
            )}
          </div>

          {/* Connected Stores Grid */}
          <h3 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#202223" }}>Connected Satellite Stores ({connectedStores.length})</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "16px", marginBottom: "24px" }}>
            {connectedStores.map((store: any) => (
              <div key={store.id} style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e1e3e5", padding: "18px 20px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <span style={{ fontWeight: "700", fontSize: "14px", color: "#202223" }}>{store.shopDomain}</span>
                    <span style={{
                      background: store.status === "active" ? "#e4f8f0" : "#fff4e5",
                      color: store.status === "active" ? "#108043" : "#b95000",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      fontSize: "11px",
                      fontWeight: "700"
                    }}>
                      {store.status === "active" ? "● Active" : "⚠ Auth Pending"}
                    </span>
                  </div>
                  <p style={{ margin: "0 0 6px 0", fontSize: "13px", color: "#6d7175" }}>📍 {store.locationName}</p>
                  <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>📦 {store.mappedCount} SKUs Synchronized</p>
                </div>
                <div style={{ marginTop: "16px", paddingTop: "12px", borderTop: "1px solid #f1f2f3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {store.status === "pending_auth" ? (
                    <a href={store.authUrl} target="_blank" rel="noreferrer" style={{ fontSize: "13px", color: "#008060", fontWeight: "600", textDecoration: "none" }}>
                      Authorize Store →
                    </a>
                  ) : (
                    <span style={{ fontSize: "12px", color: "#108043", fontWeight: "600" }}>✓ Synchronizing</span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Disconnect ${store.shopDomain}?`)) {
                        fetcher.submit({ action: "disconnectStore", storeId: store.id.toString() }, { method: "post" });
                      }
                    }}
                    style={{ background: "none", border: "none", color: "#d82c0d", fontSize: "12px", cursor: "pointer", padding: 0 }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* TAB 2: SKUs & BUFFER RULES */}
      {activeTab === "skus" && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
          <div style={{ padding: "18px 24px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h2 style={{ fontSize: "15px", fontWeight: "600", margin: 0 }}>Network Synchronized Inventory & Rules</h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#6d7175" }}>Configure safety buffers and pack multipliers per SKU across all satellites.</p>
            </div>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "autoMap" }, { method: "post" })}
              disabled={isLoading}
              style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "8px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
            >
              {isLoading ? "Syncing..." : "⚡ Resync All SKUs"}
            </button>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                <th style={{ padding: "10px 24px" }}>SKU</th>
                <th style={{ padding: "10px 24px" }}>Available Stock</th>
                <th style={{ padding: "10px 24px" }}>Safety Buffer</th>
                <th style={{ padding: "10px 24px" }}>Multiplier</th>
                <th style={{ padding: "10px 24px" }}>Connected Stores</th>
                <th style={{ padding: "10px 24px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m: any) => (
                <tr key={m.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                  <td style={{ padding: "14px 24px", fontWeight: "600" }}>{m.sku}</td>
                  <td style={{ padding: "14px 24px", fontWeight: "700" }}>
                    <span style={{ color: m.quantity <= 5 ? "#ef4444" : "#202223" }}>
                      {m.quantity} units {m.quantity <= 5 && "⚠ (Low)"}
                    </span>
                  </td>
                  <td style={{ padding: "14px 24px" }}>
                    {editingSku === m.sku ? (
                      <input
                        type="number"
                        value={bufferInput}
                        onChange={(e) => setBufferInput(e.target.value)}
                        style={{ width: "60px", padding: "4px 8px", borderRadius: "4px", border: "1px solid #d2d5d8" }}
                      />
                    ) : (
                      <span style={{ color: m.bufferQuantity > 0 ? "#b95000" : "#6d7175", fontWeight: m.bufferQuantity > 0 ? "600" : "normal" }}>
                        {m.bufferQuantity > 0 ? `Hold ${m.bufferQuantity} units reserve` : "None (0)"}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "14px 24px" }}>
                    {editingSku === m.sku ? (
                      <input
                        type="number"
                        step="0.1"
                        value={multiplierInput}
                        onChange={(e) => setMultiplierInput(e.target.value)}
                        style={{ width: "60px", padding: "4px 8px", borderRadius: "4px", border: "1px solid #d2d5d8" }}
                      />
                    ) : (
                      <span style={{ color: m.multiplier !== 1.0 ? "#108043" : "#6d7175", fontWeight: m.multiplier !== 1.0 ? "600" : "normal" }}>
                        {m.multiplier !== 1.0 ? `${m.multiplier}x (Pack)` : "1.0x"}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "14px 24px" }}>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {m.stores.map((s: string, idx: number) => (
                        <span key={idx} style={{ background: "#f1f2f4", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", color: "#5c5f62" }}>
                          {s.split(".")[0]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: "14px 24px" }}>
                    {editingSku === m.sku ? (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          onClick={() => {
                            fetcher.submit(
                              { action: "updateRule", sku: m.sku, bufferQuantity: bufferInput, multiplier: multiplierInput },
                              { method: "post" }
                            );
                          }}
                          style={{ background: "#008060", color: "#fff", border: "none", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSku(null)}
                          style={{ background: "#fff", border: "1px solid #d2d5d8", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSku(m.sku);
                          setBufferInput(m.bufferQuantity.toString());
                          setMultiplierInput(m.multiplier.toString());
                        }}
                        style={{ background: "none", border: "none", color: "#008060", fontWeight: "600", fontSize: "12px", cursor: "pointer", padding: 0 }}
                      >
                        Edit Rule
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 3: WHOLESALE PRICING RULES */}
      {activeTab === "wholesale" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{
            background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
            borderRadius: "12px",
            padding: "24px 28px",
            color: "#ffffff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "20px" }}>🏷</span>
                <h2 style={{ fontSize: "17px", fontWeight: "800", margin: 0, color: "#f8fafc" }}>
                  Wholesale vs. Retail Pricing Sync
                </h2>
              </div>
              <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#94a3b8", maxWidth: "640px" }}>
                Automatically calculate and push wholesale price tiers to your satellite stores. Set discount percentages or international price offsets.
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              {connectedStores.map((s: any) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => fetcher.submit({ action: "syncWholesalePricing", storeGroupId: s.id.toString() }, { method: "post" })}
                  disabled={isLoading}
                  style={{
                    background: "#008060",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    padding: "9px 16px",
                    fontWeight: "600",
                    fontSize: "13px",
                    cursor: "pointer",
                  }}
                >
                  ⚡ Push Prices to {s.shopDomain.split(".")[0]}
                </button>
              ))}
            </div>
          </div>

          <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e1e3e5" }}>
              <h3 style={{ fontSize: "15px", fontWeight: "600", margin: 0 }}>Satellite Pricing Configurations</h3>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                  <th style={{ padding: "10px 24px" }}>Store</th>
                  <th style={{ padding: "10px 24px" }}>Wholesale Rule</th>
                  <th style={{ padding: "10px 24px" }}>Price Offset</th>
                  <th style={{ padding: "10px 24px" }}>Sample Price ($50 Base)</th>
                  <th style={{ padding: "10px 24px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {connectedStores.map((store: any) => {
                  const isEditing = editingStoreSettings === store.id;
                  const mult = store.priceMultiplier || 1.0;
                  const off = store.priceOffset || 0.0;
                  const sampleCalculated = ((50 * mult) + off).toFixed(2);

                  return (
                    <tr key={store.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "14px 24px", fontWeight: "600" }}>{store.shopDomain}</td>
                      <td style={{ padding: "14px 24px" }}>
                        {isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <input
                              type="number"
                              step="0.05"
                              value={priceMultiplierInput}
                              onChange={(e) => setPriceMultiplierInput(e.target.value)}
                              style={{ width: "70px", padding: "4px 8px", borderRadius: "4px", border: "1px solid #d2d5d8" }}
                            />
                            <span style={{ fontSize: "11px", color: "#6d7175" }}>
                              ({Math.round((1 - parseFloat(priceMultiplierInput || "1")) * 100)}% discount)
                            </span>
                          </div>
                        ) : (
                          <span style={{ fontWeight: "600", color: mult !== 1.0 ? "#008060" : "#202223" }}>
                            {mult !== 1.0 ? `${mult}x (${Math.round((1 - mult) * 100)}% wholesale discount)` : "1.0x (Retail 1:1)"}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "14px 24px" }}>
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.5"
                            value={priceOffsetInput}
                            onChange={(e) => setPriceOffsetInput(e.target.value)}
                            style={{ width: "70px", padding: "4px 8px", borderRadius: "4px", border: "1px solid #d2d5d8" }}
                          />
                        ) : (
                          <span style={{ color: off !== 0 ? "#008060" : "#6d7175" }}>
                            {off > 0 ? `+$${off.toFixed(2)}` : off < 0 ? `-$${Math.abs(off).toFixed(2)}` : "$0.00"}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "14px 24px", fontWeight: "700", color: "#008060" }}>
                        ${sampleCalculated}
                      </td>
                      <td style={{ padding: "14px 24px" }}>
                        {isEditing ? (
                          <div style={{ display: "flex", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => {
                                fetcher.submit(
                                  {
                                    action: "updateStoreSettings",
                                    storeGroupId: store.id.toString(),
                                    priceMultiplier: priceMultiplierInput,
                                    priceOffset: priceOffsetInput,
                                    orderForwardingEnabled: orderForwardingInput ? "true" : "false",
                                  },
                                  { method: "post" }
                                );
                                setEditingStoreSettings(null);
                              }}
                              style={{ background: "#008060", color: "#fff", border: "none", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" }}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingStoreSettings(null)}
                              style={{ background: "#fff", border: "1px solid #d2d5d8", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", cursor: "pointer" }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingStoreSettings(store.id);
                              setPriceMultiplierInput(mult.toString());
                              setPriceOffsetInput(off.toString());
                              setOrderForwardingInput(store.orderForwardingEnabled);
                            }}
                            style={{ background: "none", border: "none", color: "#008060", fontWeight: "600", fontSize: "12px", cursor: "pointer", padding: 0 }}
                          >
                            Edit Pricing Rule
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: ORDER ROUTING ('GHOST ROUTING') */}
      {activeTab === "orders" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{
            background: "linear-gradient(135deg, #064e3b 0%, #022c22 100%)",
            borderRadius: "12px",
            padding: "24px 28px",
            color: "#ffffff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "20px" }}>📦</span>
                <h2 style={{ fontSize: "17px", fontWeight: "800", margin: 0, color: "#a7f3d0" }}>
                  Cross-Store Order Forwarding
                </h2>
              </div>
              <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#6ee7b7", maxWidth: "640px" }}>
                Orders placed on satellite storefronts automatically mirror into Master Hub as unfulfilled shadow orders so your central warehouse can fulfill them seamlessly.
              </p>
            </div>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "simulateOrderForward" }, { method: "post", action: "/app?index" })}
              disabled={isLoading}
              style={{
                background: "#10b981",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "9px 18px",
                fontWeight: "700",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              {isLoading ? "Mirroring..." : "⚡ Simulate Satellite Order"}
            </button>
          </div>

          <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "15px", fontWeight: "600", margin: 0 }}>Forwarded Orders Queue</h3>
              <span style={{ fontSize: "12px", color: "#6d7175" }}>{data.forwardedOrders?.length || 0} orders recorded</span>
            </div>

            {(!data.forwardedOrders || data.forwardedOrders.length === 0) ? (
              <div style={{ padding: "36px", textAlign: "center", color: "#6d7175" }}>
                <p style={{ margin: 0, fontSize: "13px" }}>No cross-store orders forwarded yet. Click "Simulate Satellite Order" to test real-time mirroring!</p>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                    <th style={{ padding: "10px 24px" }}>Order</th>
                    <th style={{ padding: "10px 24px" }}>Source Satellite</th>
                    <th style={{ padding: "10px 24px" }}>Customer</th>
                    <th style={{ padding: "10px 24px" }}>Total</th>
                    <th style={{ padding: "10px 24px" }}>Status</th>
                    <th style={{ padding: "10px 24px" }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.forwardedOrders.map((ord: any) => (
                    <tr key={ord.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "12px 24px", fontWeight: "700" }}>{ord.orderNumber}</td>
                      <td style={{ padding: "12px 24px" }}>
                        <span style={{ background: "#f1f2f4", padding: "2px 8px", borderRadius: "10px", fontSize: "11px" }}>
                          {ord.satelliteShop.split(".")[0]}
                        </span>
                      </td>
                      <td style={{ padding: "12px 24px", color: "#6d7175" }}>{ord.customerEmail || "—"}</td>
                      <td style={{ padding: "12px 24px", fontWeight: "600" }}>${ord.totalPrice}</td>
                      <td style={{ padding: "12px 24px" }}>
                        <span style={{ background: "#e0f2fe", color: "#0369a1", padding: "3px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "700" }}>
                          {ord.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px 24px", color: "#6d7175", fontFamily: "monospace" }}>{ord.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: SMART MATCH & CATALOG CLONER (KILLER DIFFERENTIATOR) */}
      {activeTab === "smartMatch" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Hero Banner for 1-Click Push */}
          <div style={{
            background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
            borderRadius: "12px",
            padding: "24px 28px",
            color: "#ffffff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
            boxShadow: "0 4px 14px rgba(49, 46, 129, 0.2)",
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "20px" }}>🚀</span>
                <h2 style={{ fontSize: "17px", fontWeight: "800", margin: 0, color: "#e0e7ff" }}>
                  1-Click Catalog Push & Auto-Sync
                </h2>
              </div>
              <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#c7d2fe", maxWidth: "640px" }}>
                Instantly push all products and variants from Master Hub to your satellite stores. GhostSync will create the products in Shopify and link their inventory automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "cloneCatalogToSatellite" }, { method: "post" })}
              disabled={isLoading}
              style={{
                background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                color: "#ffffff",
                border: "none",
                borderRadius: "8px",
                padding: "11px 22px",
                fontWeight: "700",
                fontSize: "13px",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(79, 70, 229, 0.4)",
              }}
            >
              {isLoading ? "Pushing Catalog..." : "Clone & Push to Satellites"}
            </button>
          </div>

          {/* Smart Fuzzy SKU Matcher Section */}
          <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <h3 style={{ fontSize: "15px", fontWeight: "700", margin: "0 0 4px 0", color: "#202223" }}>
                  AI & Fuzzy SKU Match Suggestions
                </h3>
                <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>
                  Detects products with slight SKU or title differences between stores (e.g. abbreviations, sizes, dashes) and pairs them with confidence scoring.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetcher.submit({ action: "scanFuzzyMatches" }, { method: "post" })}
                disabled={isLoading}
                style={{ background: "#f4f4f5", color: "#18181b", border: "1px solid #d4d4d8", borderRadius: "6px", padding: "8px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
              >
                {isLoading ? "Analyzing Catalogs..." : "✨ Scan for Smart Matches"}
              </button>
            </div>

            {fuzzySuggestions === null ? (
              <div style={{ padding: "30px", textAlign: "center", background: "#f8f9fa", borderRadius: "8px", border: "1px dashed #d2d5d8" }}>
                <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>
                  Click <strong>Scan for Smart Matches</strong> to inspect your stores for unmapped products and AI pairings.
                </p>
              </div>
            ) : fuzzySuggestions.length === 0 ? (
              <div style={{ padding: "24px", textAlign: "center", background: "#f0fdf4", borderRadius: "8px", border: "1px solid #bbf7d0", color: "#166534" }}>
                <p style={{ margin: 0, fontWeight: "600", fontSize: "13px" }}>
                  ✓ All products across your store cluster are either 100% mapped or in sync!
                </p>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                    <th style={{ padding: "10px 16px" }}>Hub SKU & Product</th>
                    <th style={{ padding: "10px 16px" }}>Satellite Candidate</th>
                    <th style={{ padding: "10px 16px" }}>Confidence</th>
                    <th style={{ padding: "10px 16px" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {fuzzySuggestions.map((s: any, idx: number) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: "700" }}>{s.skuA}</div>
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>{s.titleA}</div>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: "700", color: "#4338ca" }}>{s.skuB}</div>
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>{s.titleB}</div>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{
                          background: s.confidence >= 85 ? "#e4f8f0" : "#fff4e5",
                          color: s.confidence >= 85 ? "#108043" : "#b95000",
                          padding: "3px 8px",
                          borderRadius: "10px",
                          fontWeight: "800",
                          fontSize: "11px",
                        }}>
                          {s.confidence}% Match
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <button
                          type="button"
                          onClick={() => {
                            fetcher.submit(
                              {
                                action: "approveFuzzyMatch",
                                storeGroupId: s.storeGroupId.toString(),
                                skuA: s.skuA,
                                varIdA: s.variantIdA,
                                invItemIdA: s.inventoryItemIdA,
                                varIdB: s.variantIdB,
                                invItemIdB: s.inventoryItemIdB,
                                qtyA: s.quantityA.toString(),
                              },
                              { method: "post" }
                            );
                          }}
                          style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "6px 12px", fontSize: "12px", fontWeight: "600", cursor: "pointer" }}
                        >
                          Approve Link
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: DISCREPANCY SCANNER */}
      {activeTab === "scanner" && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h2 style={{ fontSize: "16px", fontWeight: "600", margin: "0 0 4px 0" }}>Inventory Drift & Health Scanner</h2>
              <p style={{ margin: 0, fontSize: "13px", color: "#6d7175" }}>Compare real-time stock levels across all stores to detect drift caused by offline sales or manual edits.</p>
            </div>
            <button
              type="button"
              onClick={() => fetcher.submit({ action: "scanDiscrepancies" }, { method: "post" })}
              disabled={isLoading}
              style={{ background: "#008060", color: "#ffffff", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
            >
              {isLoading ? "Scanning Network..." : "🔍 Run Health Scan"}
            </button>
          </div>

          {discrepancies !== null && (
            <div style={{ marginTop: "16px" }}>
              {discrepancies.length === 0 ? (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "20px", textAlign: "center", color: "#166534" }}>
                  <p style={{ margin: 0, fontWeight: "600", fontSize: "14px" }}>✓ Perfect Alignment: All stores in your cluster match 100%.</p>
                </div>
              ) : (
                <div style={{ background: "#fffbf0", border: "1px solid #fedf89", borderRadius: "8px", padding: "20px" }}>
                  <h3 style={{ fontSize: "15px", fontWeight: "700", color: "#b54708", margin: "0 0 12px 0" }}>
                    ⚠ {discrepancies.length} Inventory Variances Detected
                  </h3>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", background: "#ffffff", borderRadius: "6px", overflow: "hidden" }}>
                    <thead>
                      <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                        <th style={{ padding: "10px 16px" }}>SKU</th>
                        <th style={{ padding: "10px 16px" }}>Hub Stock</th>
                        <th style={{ padding: "10px 16px" }}>Satellite Store</th>
                        <th style={{ padding: "10px 16px" }}>Satellite Stock</th>
                        <th style={{ padding: "10px 16px" }}>Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discrepancies.map((d: any, idx: number) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #f1f2f3" }}>
                          <td style={{ padding: "10px 16px", fontWeight: "600" }}>{d.sku}</td>
                          <td style={{ padding: "10px 16px", fontWeight: "700" }}>{d.qtyA} units</td>
                          <td style={{ padding: "10px 16px", color: "#6d7175" }}>{d.shopB}</td>
                          <td style={{ padding: "10px 16px", fontWeight: "700", color: "#d82c0d" }}>{d.qtyB} units</td>
                          <td style={{ padding: "10px 16px", color: "#b54708", fontWeight: "600" }}>{d.diff > 0 ? `+${d.diff}` : d.diff}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => fetcher.submit({ action: "autoMap" }, { method: "post" })}
                      style={{ background: "#008060", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                    >
                      ⚡ Align & Sync All to Master
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 5: SYNC AUDIT LOG & TELEMETRY */}
      {activeTab === "logs" && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
          <div style={{ padding: "18px 24px", borderBottom: "1px solid #e1e3e5", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h2 style={{ fontSize: "15px", fontWeight: "600", margin: 0 }}>High-Resolution Telemetry & Audit Trail</h2>
              <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "#6d7175" }}>Granular audit record of every webhook, latency roundtrip, and buffer calculation.</p>
            </div>
            <span style={{ fontSize: "12px", color: "#6d7175" }}>Showing last {logs.length} events</span>
          </div>

          {logs.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#6d7175" }}>
              <p style={{ margin: 0, fontSize: "14px" }}>No sync events recorded yet. Adjust inventory on any store to see live telemetry!</p>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left", borderBottom: "1px solid #e1e3e5", color: "#6d7175" }}>
                  <th style={{ padding: "10px 24px" }}>Timestamp</th>
                  <th style={{ padding: "10px 24px" }}>SKU</th>
                  <th style={{ padding: "10px 24px" }}>Route</th>
                  <th style={{ padding: "10px 24px" }}>Delta</th>
                  <th style={{ padding: "10px 24px" }}>Latency</th>
                  <th style={{ padding: "10px 24px" }}>Status</th>
                  <th style={{ padding: "10px 24px" }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: any) => (
                  <tr key={log.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                    <td style={{ padding: "12px 24px", color: "#6d7175", fontFamily: "monospace" }}>{log.time}</td>
                    <td style={{ padding: "12px 24px", fontWeight: "600" }}>{log.sku}</td>
                    <td style={{ padding: "12px 24px" }}>
                      <span style={{ fontSize: "12px" }}>{log.sourceShop.split(".")[0]} ➔ {log.destShop.split(".")[0]}</span>
                    </td>
                    <td style={{ padding: "12px 24px", fontWeight: "700" }}>
                      {log.oldQuantity} ➔ {log.newQuantity}
                    </td>
                    <td style={{ padding: "12px 24px", fontFamily: "monospace", color: "#008060", fontWeight: "600" }}>
                      {log.latencyMs}ms
                    </td>
                    <td style={{ padding: "12px 24px" }}>
                      <span style={{
                        background: log.status === "SUCCESS" ? "#e4f8f0" : log.status === "BUFFERED" ? "#fff4e5" : log.status === "TRIPPED" ? "#fee2e2" : "#fee4e2",
                        color: log.status === "SUCCESS" ? "#108043" : log.status === "BUFFERED" ? "#b95000" : log.status === "TRIPPED" ? "#b91c1c" : "#d92d20",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        fontSize: "11px",
                        fontWeight: "700",
                      }}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 24px", color: "#6d7175", fontSize: "12px" }}>{log.details || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* TAB 8: PERFORMANCE TIERS (SYNCIO-STYLE, CHEAPER) */}
      {activeTab === "pricing" && (
        <div style={{ background: "#ffffff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "28px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px", marginBottom: "28px" }}>
            <div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#fef3c7", border: "1px solid #fde68a", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "700", color: "#92400e", marginBottom: "8px" }}>
                <span>⚡</span> PERFORMANCE-BASED SOURCE PRICING
              </div>
              <h2 style={{ fontSize: "20px", fontWeight: "800", margin: "0 0 6px 0", color: "#18181b" }}>Your Monthly Performance Usage</h2>
              <p style={{ margin: 0, fontSize: "13px", color: "#71717a" }}>
                GhostSync automatically meters orders containing synced products each month. Start free every month and pay only as you scale.
              </p>
            </div>

            {/* Current Tier Summary Card */}
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "16px 20px", minWidth: "260px" }}>
              <div style={{ fontSize: "11px", color: "#64748b", fontWeight: "600", textTransform: "uppercase" }}>Current Active Tier</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginTop: "4px" }}>
                <span style={{ fontSize: "24px", fontWeight: "800", color: "#0f172a" }}>{data.performanceTier}</span>
                <span style={{ fontSize: "14px", fontWeight: "600", color: "#10b981" }}>{data.tierCost}</span>
              </div>
              <div style={{ marginTop: "10px", fontSize: "12px", color: "#334155" }}>
                <strong>{data.monthlySyncedOrdersCount || 0}</strong> / {data.tierOrderLimit} synced orders used this billing period
              </div>
              {/* Progress bar */}
              <div style={{ width: "100%", height: "6px", background: "#e2e8f0", borderRadius: "4px", marginTop: "8px", overflow: "hidden" }}>
                <div style={{
                  width: `${Math.min(100, Math.round(((data.monthlySyncedOrdersCount || 0) / (data.tierOrderLimit || 25)) * 100))}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #10b981, #0284c7)",
                }} />
              </div>
            </div>
          </div>

          {/* Tier Cards Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "32px" }}>
            {/* Free */}
            <div style={{
              background: data.performanceTier === "Free" ? "#f0fdf4" : "#ffffff",
              border: data.performanceTier === "Free" ? "2px solid #10b981" : "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "20px",
              position: "relative",
            }}>
              {data.performanceTier === "Free" && (
                <span style={{ position: "absolute", top: "-10px", right: "16px", background: "#10b981", color: "#ffffff", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "800" }}>CURRENT TIER</span>
              )}
              <div style={{ fontSize: "11px", fontWeight: "700", color: "#10b981", textTransform: "uppercase" }}>Start Here Each Month</div>
              <h3 style={{ fontSize: "18px", fontWeight: "800", margin: "4px 0 8px 0" }}>Free</h3>
              <div style={{ fontSize: "24px", fontWeight: "800", margin: "0 0 12px 0" }}>$0<span style={{ fontSize: "12px", fontWeight: "400", color: "#64748b" }}> / mo</span></div>
              <div style={{ background: "rgba(0,0,0,0.04)", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", marginBottom: "12px" }}>
                0 – 25 Orders / mo
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
                <li>✓ Connect 2 Stores</li>
                <li>✓ Unlimited SKUs</li>
                <li>✓ Sub-Second Webhooks</li>
              </ul>
            </div>

            {/* Starter */}
            <div style={{
              background: data.performanceTier === "Starter" ? "#f0fdf4" : "#ffffff",
              border: data.performanceTier === "Starter" ? "2px solid #10b981" : "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "20px",
              position: "relative",
            }}>
              {data.performanceTier === "Starter" && (
                <span style={{ position: "absolute", top: "-10px", right: "16px", background: "#10b981", color: "#ffffff", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "800" }}>CURRENT TIER</span>
              )}
              <div style={{ fontSize: "11px", fontWeight: "700", color: "#6366f1", textTransform: "uppercase" }}>Syncio: $19/mo</div>
              <h3 style={{ fontSize: "18px", fontWeight: "800", margin: "4px 0 8px 0" }}>Starter</h3>
              <div style={{ fontSize: "24px", fontWeight: "800", margin: "0 0 12px 0" }}>$9<span style={{ fontSize: "12px", fontWeight: "400", color: "#64748b" }}> / mo</span></div>
              <div style={{ background: "rgba(0,0,0,0.04)", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", marginBottom: "12px" }}>
                26 – 150 Orders / mo
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
                <li>✓ Up to 4 Stores</li>
                <li>✓ SpeedSurge Flash Mode</li>
                <li>✓ Drift Doctor Auto-Heal</li>
              </ul>
            </div>

            {/* Pro Growth */}
            <div style={{
              background: data.performanceTier === "Pro Growth" ? "#f0fdf4" : "#f8fafc",
              border: data.performanceTier === "Pro Growth" ? "2px solid #10b981" : "1px solid #cbd5e1",
              borderRadius: "12px",
              padding: "20px",
              position: "relative",
            }}>
              {data.performanceTier === "Pro Growth" && (
                <span style={{ position: "absolute", top: "-10px", right: "16px", background: "#10b981", color: "#ffffff", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "800" }}>CURRENT TIER</span>
              )}
              <div style={{ fontSize: "11px", fontWeight: "700", color: "#0284c7", textTransform: "uppercase" }}>Syncio: $49/mo</div>
              <h3 style={{ fontSize: "18px", fontWeight: "800", margin: "4px 0 8px 0" }}>Pro Growth</h3>
              <div style={{ fontSize: "24px", fontWeight: "800", margin: "0 0 12px 0" }}>$29<span style={{ fontSize: "12px", fontWeight: "400", color: "#64748b" }}> / mo</span></div>
              <div style={{ background: "rgba(0,0,0,0.04)", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", marginBottom: "12px" }}>
                151 – 1,500 Orders / mo
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
                <li>✓ Unlimited Stores</li>
                <li>✓ Safety Stock Buffers</li>
                <li>✓ Wholesale Multipliers</li>
                <li>✓ Cross-Store Order Forwarding</li>
              </ul>
            </div>

            {/* Enterprise */}
            <div style={{
              background: data.performanceTier === "Enterprise" ? "#f0fdf4" : "#ffffff",
              border: data.performanceTier === "Enterprise" ? "2px solid #10b981" : "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "20px",
              position: "relative",
            }}>
              {data.performanceTier === "Enterprise" && (
                <span style={{ position: "absolute", top: "-10px", right: "16px", background: "#10b981", color: "#ffffff", padding: "2px 8px", borderRadius: "10px", fontSize: "10px", fontWeight: "800" }}>CURRENT TIER</span>
              )}
              <div style={{ fontSize: "11px", fontWeight: "700", color: "#d97706", textTransform: "uppercase" }}>Syncio: $99/mo</div>
              <h3 style={{ fontSize: "18px", fontWeight: "800", margin: "4px 0 8px 0" }}>Enterprise</h3>
              <div style={{ fontSize: "24px", fontWeight: "800", margin: "0 0 12px 0" }}>$59<span style={{ fontSize: "12px", fontWeight: "400", color: "#64748b" }}> / mo</span></div>
              <div style={{ background: "rgba(0,0,0,0.04)", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", marginBottom: "12px" }}>
                1,501 – 10,000+ Orders / mo
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
                <li>✓ High-Volume Scale SLA</li>
                <li>✓ Dedicated Hardware Support</li>
                <li>✓ Priority Engineering Desk</li>
              </ul>
            </div>
          </div>

          {/* Syncio Comparison Table */}
          <div style={{ background: "#f8fafc", borderRadius: "10px", border: "1px solid #e2e8f0", padding: "20px" }}>
            <h4 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
              💡 Direct Price Comparison vs. Syncio
            </h4>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                  <th style={{ padding: "8px 12px" }}>Monthly Synced Orders</th>
                  <th style={{ padding: "8px 12px" }}>Syncio Price</th>
                  <th style={{ padding: "8px 12px", color: "#059669" }}>GhostSync Price</th>
                  <th style={{ padding: "8px 12px", color: "#059669" }}>Your Merchant Savings</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", fontWeight: "600" }}>0 – 10 orders</td>
                  <td style={{ padding: "8px 12px" }}>Free</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>FREE</td>
                  <td style={{ padding: "8px 12px", color: "#64748b" }}>Equal</td>
                </tr>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", fontWeight: "600" }}>11 – 25 orders</td>
                  <td style={{ padding: "8px 12px", color: "#dc2626" }}>$19 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>FREE (Up to 25)</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>Save $19 / mo (100% OFF)</td>
                </tr>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", fontWeight: "600" }}>26 – 100 orders</td>
                  <td style={{ padding: "8px 12px" }}>$19 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>$9 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>Save $10 / mo (53% OFF)</td>
                </tr>
                <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", fontWeight: "600" }}>101 – 1,000 orders</td>
                  <td style={{ padding: "8px 12px" }}>$49 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>$29 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>Save $20 / mo (41% OFF)</td>
                </tr>
                <tr>
                  <td style={{ padding: "8px 12px", fontWeight: "600" }}>1,001 – 10,000 orders</td>
                  <td style={{ padding: "8px 12px" }}>$99 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>$59 / month</td>
                  <td style={{ padding: "8px 12px", fontWeight: "700", color: "#059669" }}>Save $40 / mo (40% OFF)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
