import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[GDPR] Received ${topic} webhook for ${shop}`);

  try {
    // Delete session records
    await db.session.deleteMany({ where: { shop } });

    // Find store record
    const store = await db.store.findUnique({ where: { shopDomain: shop } });
    if (store) {
      await db.syncLog.deleteMany({
        where: {
          OR: [{ sourceShop: shop }, { targetShop: shop }],
        },
      });

      await db.inventoryMapping.deleteMany({
        where: {
          OR: [{ sourceStoreId: store.id }, { targetStoreId: store.id }],
        },
      });

      await db.store.delete({ where: { id: store.id } });
      console.log(`[GDPR] Successfully purged database records for shop: ${shop}`);
    }
  } catch (error) {
    console.error(`[GDPR] Error purging data for shop ${shop}:`, error);
  }

  return new Response(JSON.stringify({ message: "Shop data purged successfully" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
