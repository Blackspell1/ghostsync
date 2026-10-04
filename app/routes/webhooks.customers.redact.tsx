import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[GDPR] Received ${topic} webhook for ${shop}`);

  // GhostSync stores no customer PII to redact.
  return new Response(JSON.stringify({ message: "No customer PII stored to redact" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
