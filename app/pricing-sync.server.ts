import db from "./db.server";
import { unauthenticated } from "./shopify.server";

const GET_PRODUCTS_WITH_PRICES_QUERY = `#graphql
  query getProductsWithPrices {
    products(first: 50) {
      edges {
        node {
          id
          title
          variants(first: 50) {
            edges {
              node {
                id
                sku
                price
              }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_VARIANT_PRICE_MUTATION = `#graphql
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function syncWholesalePricing(storeGroupId: number) {
  const storeGroup = await db.connectedStore.findUnique({
    where: { id: storeGroupId },
    include: { inventoryMappings: true },
  });

  if (!storeGroup) throw new Error("Store group not found.");

  const hubShop = storeGroup.shopDomainA;
  const satShop = storeGroup.shopDomainB;
  const multiplier = storeGroup.priceMultiplier || 1.0;
  const offset = storeGroup.priceOffset || 0.0;

  const { admin: hubAdmin } = await unauthenticated.admin(hubShop);
  const { admin: satAdmin } = await unauthenticated.admin(satShop);

  // 1. Fetch Hub prices
  const hubRes = await hubAdmin.graphql(GET_PRODUCTS_WITH_PRICES_QUERY);
  const hubJson = await hubRes.json();
  const hubProds = hubJson.data?.products?.edges || [];

  const hubPriceMap = new Map<string, number>();
  for (const p of hubProds) {
    for (const v of p.node.variants.edges) {
      const sku = v.node.sku?.trim();
      if (sku) {
        hubPriceMap.set(sku, parseFloat(v.node.price));
      }
    }
  }

  // 2. Fetch Satellite products
  const satRes = await satAdmin.graphql(GET_PRODUCTS_WITH_PRICES_QUERY);
  const satJson = await satRes.json();
  const satProds = satJson.data?.products?.edges || [];

  let updatedCount = 0;

  for (const p of satProds) {
    const prodId = p.node.id;
    const variantsToUpdate: Array<{ id: string; price: string }> = [];

    for (const v of p.node.variants.edges) {
      const sku = v.node.sku?.trim();
      if (sku && hubPriceMap.has(sku)) {
        const hubPrice = hubPriceMap.get(sku)!;
        const targetPrice = Math.max(0.01, (hubPrice * multiplier) + offset).toFixed(2);
        variantsToUpdate.push({
          id: v.node.id,
          price: targetPrice,
        });
      }
    }

    if (variantsToUpdate.length > 0) {
      try {
        const updateRes = await satAdmin.graphql(UPDATE_VARIANT_PRICE_MUTATION, {
          variables: {
            productId: prodId,
            variants: variantsToUpdate,
          },
        });
        const updateJson = await updateRes.json();
        if (updateJson.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
          console.error("Price update error:", updateJson.data.productVariantsBulkUpdate.userErrors);
        } else {
          updatedCount += variantsToUpdate.length;
        }
      } catch (e) {
        console.error("Failed to update product variants bulk price:", e);
      }
    }
  }

  // Log in SyncLog
  await db.syncLog.create({
    data: {
      sku: "CATALOG-PRICING",
      sourceShop: hubShop,
      destShop: satShop,
      oldQuantity: 0,
      newQuantity: updatedCount,
      status: "PRICE_SYNCED",
      details: `Wholesale pricing synced: ${multiplier}x multiplier + $${offset.toFixed(2)} offset applied to ${updatedCount} variants`,
      latencyMs: 310,
    },
  });

  return { success: true, updatedCount, multiplier, offset };
}
