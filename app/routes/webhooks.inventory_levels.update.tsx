import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processInventorySync } from "../inventory-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  
  console.log(`Received ${topic} webhook for ${shop}`);
  
  // Fire and forget asynchronous processing
  processInventorySync({ shop, payload }).catch((err) => {
    console.error("Error processing inventory sync in background:", err);
  });
  
  return new Response("OK", { status: 200 });
};
