import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[GDPR] Received ${topic} webhook for ${shop}`);

  // GhostSync stores no customer PII, only shop inventory levels and SKU mappings.
  return new Response(JSON.stringify({ message: "No customer PII stored" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
