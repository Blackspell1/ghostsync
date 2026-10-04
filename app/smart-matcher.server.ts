import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// Levenshtein similarity algorithm
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const track = Array(s2.length + 1).fill(null).map(() =>
    Array(s1.length + 1).fill(null)
  );
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }

  const distance = track[s2.length][s1.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.max(0, 1 - distance / maxLen);
}

const GET_PRODUCTS_QUERY = `#graphql
  query getProductsWithInventory {
    products(first: 50) {
      edges {
        node {
          id
          title
          handle
          images(first: 1) {
            edges {
              node {
                url
              }
            }
          }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                price
                barcode
                inventoryItem {
                  id
                  tracked
                }
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
`;

const CREATE_PRODUCT_MUTATION = `#graphql
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
        variants(first: 10) {
          edges {
            node {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface FuzzyMatchSuggestion {
  skuA: string;
  titleA: string;
  variantIdA: string;
  inventoryItemIdA: string;
  quantityA: number;
  skuB: string;
  titleB: string;
  variantIdB: string;
  inventoryItemIdB: string;
  confidence: number;
  storeGroupId: number;
}

export async function getFuzzyMatchSuggestions(hubShop: string, satelliteShop: string, storeGroupId: number): Promise<FuzzyMatchSuggestion[]> {
  const { admin: adminA } = await unauthenticated.admin(hubShop);
  const { admin: adminB } = await unauthenticated.admin(satelliteShop);

  const [resA, resB] = await Promise.all([
    adminA.graphql(GET_PRODUCTS_QUERY),
    adminB.graphql(GET_PRODUCTS_QUERY),
  ]);

  const jsonA = await resA.json();
  const jsonB = await resB.json();

  const prodsA = jsonA.data?.products?.edges || [];
  const prodsB = jsonB.data?.products?.edges || [];

  // Get existing mapped SKUs to exclude
  const existingMappings = await db.inventoryMapping.findMany({
    where: { storeGroupId },
  });
  const mappedSkus = new Set(existingMappings.map((m) => m.sku));

  const itemsA: Array<{ sku: string; title: string; variantId: string; inventoryItemId: string; quantity: number }> = [];
  for (const edge of prodsA) {
    for (const vEdge of edge.node.variants.edges) {
      const sku = vEdge.node.sku?.trim();
      if (sku && !mappedSkus.has(sku)) {
        itemsA.push({
          sku,
          title: `${edge.node.title} - ${vEdge.node.title}`,
          variantId: vEdge.node.id,
          inventoryItemId: vEdge.node.inventoryItem?.id,
          quantity: vEdge.node.inventoryQuantity || 0,
        });
      }
    }
  }

  const itemsB: Array<{ sku: string; title: string; variantId: string; inventoryItemId: string }> = [];
  for (const edge of prodsB) {
    for (const vEdge of edge.node.variants.edges) {
      const sku = vEdge.node.sku?.trim();
      if (sku) {
        itemsB.push({
          sku,
          title: `${edge.node.title} - ${vEdge.node.title}`,
          variantId: vEdge.node.id,
          inventoryItemId: vEdge.node.inventoryItem?.id,
        });
      }
    }
  }

  const suggestions: FuzzyMatchSuggestion[] = [];

  for (const a of itemsA) {
    let bestMatch: (typeof itemsB)[0] | null = null;
    let highestScore = 0;

    for (const b of itemsB) {
      // Calculate similarity across SKU and product titles
      const skuScore = calculateSimilarity(a.sku, b.sku);
      const titleScore = calculateSimilarity(a.title, b.title);
      const combinedScore = Math.max(skuScore, titleScore * 0.85);

      if (combinedScore > highestScore && combinedScore >= 0.5) {
        highestScore = combinedScore;
        bestMatch = b;
      }
    }

    if (bestMatch && highestScore >= 0.5) {
      suggestions.push({
        skuA: a.sku,
        titleA: a.title,
        variantIdA: a.variantId,
        inventoryItemIdA: a.inventoryItemId,
        quantityA: a.quantity,
        skuB: bestMatch.sku,
        titleB: bestMatch.title,
        variantIdB: bestMatch.variantId,
        inventoryItemIdB: bestMatch.inventoryItemId,
        confidence: Math.round(highestScore * 100),
        storeGroupId,
      });
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

// 1-Click Catalog Auto-Clone / Push to Satellite Store
export async function autoCloneCatalogToSatellite(hubShop: string, satelliteShop: string, storeGroupId: number) {
  const { admin: adminA } = await unauthenticated.admin(hubShop);
  const { admin: adminB } = await unauthenticated.admin(satelliteShop);

  const resA = await adminA.graphql(GET_PRODUCTS_QUERY);
  const jsonA = await resA.json();
  const prodsA = jsonA.data?.products?.edges || [];

  // Check what's already mapped
  const existingMappings = await db.inventoryMapping.findMany({
    where: { storeGroupId },
  });
  const mappedSkus = new Set(existingMappings.map((m) => m.sku));

  let clonedCount = 0;

  for (const pEdge of prodsA) {
    const p = pEdge.node;
    for (const vEdge of p.variants.edges) {
      const v = vEdge.node;
      const sku = v.sku?.trim();

      if (!sku || mappedSkus.has(sku)) continue;

      // Clone product + variant to Store B
      try {
        const createRes = await adminB.graphql(CREATE_PRODUCT_MUTATION, {
          variables: {
            input: {
              title: `${p.title}`,
              variants: [
                {
                  sku,
                  price: v.price,
                  barcode: v.barcode,
                  inventoryItem: {
                    tracked: true,
                  },
                },
              ],
            },
          },
        });

        const createJson = await createRes.json();
        const createdProd = createJson.data?.productCreate?.product;

        if (createdProd && createdProd.variants?.edges?.length > 0) {
          const newVariant = createdProd.variants.edges[0].node;
          const newInvItemId = newVariant.inventoryItem.id.split("/").pop();
          const origInvItemId = v.inventoryItem.id.split("/").pop();
          const origVarId = v.id.split("/").pop();
          const newVarId = newVariant.id.split("/").pop();

          // Create inventory mapping
          await db.inventoryMapping.create({
            data: {
              storeGroupId,
              sku,
              variantIdA: BigInt(origVarId),
              inventoryItemIdA: BigInt(origInvItemId),
              variantIdB: BigInt(newVarId),
              inventoryItemIdB: BigInt(newInvItemId),
              syncedQuantity: v.inventoryQuantity || 0,
            },
          });

          clonedCount++;
          mappedSkus.add(sku);
        }
      } catch (e) {
        console.error(`[Catalog Clone] Failed cloning SKU ${sku} to ${satelliteShop}:`, e);
      }
    }
  }

  return { success: true, clonedCount };
}
