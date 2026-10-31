import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

// Fallback plain email parser for raw MIME email bodies
function parseMimeEmail(raw: string) {
  let fromAddress = "unknown@sender.com";
  let fromName: string | null = null;
  let toAddress = "inbox@fmv.lol";
  let subject = "(No Subject)";
  let textBody = "";
  let htmlBody = "";

  const headerEnd = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headerBlock = headerEnd !== -1 ? raw.substring(0, headerEnd) : raw;
  const bodyBlock = headerEnd !== -1 ? raw.substring(headerEnd).trim() : "";

  // Parse header lines
  const lines = headerBlock.split(/\r?\n/);
  const headers: Record<string, string> = {};
  let currentKey = "";

  for (const line of lines) {
    if (/^\s+/.test(line) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        currentKey = match[1].toLowerCase();
        headers[currentKey] = match[2].trim();
      }
    }
  }

  if (headers["from"]) {
    const fromLine = headers["from"];
    const nameMatch = fromLine.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
    if (nameMatch) {
      fromName = nameMatch[1].trim();
      fromAddress = nameMatch[2].trim().toLowerCase();
    } else {
      const emailOnly = fromLine.match(/<([^>]+)>/);
      if (emailOnly) {
        fromAddress = emailOnly[1].trim().toLowerCase();
      } else {
        fromAddress = fromLine.trim().toLowerCase();
      }
    }
  }

  if (headers["to"]) {
    const toLine = headers["to"];
    const toMatch = toLine.match(/<([^>]+)>/);
    if (toMatch) {
      toAddress = toMatch[1].trim().toLowerCase();
    } else {
      toAddress = toLine.trim().toLowerCase();
    }
  }

  if (headers["subject"]) {
    subject = headers["subject"];
  }

  // Body extraction
  if (bodyBlock) {
    // If multipart
    if (bodyBlock.includes("------") || bodyBlock.includes("boundary=")) {
      textBody = bodyBlock.replace(/--[a-zA-Z0-9_-]+(--)?/g, "").trim();
    } else {
      textBody = bodyBlock;
    }
  }

  return { fromAddress, fromName, toAddress, subject, textBody, htmlBody };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response(JSON.stringify({ status: "active", endpoint: "/api/email-inbound" }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let toAddress = "";
    let fromAddress = "";
    let fromName: string | null = null;
    let subject = "(No Subject)";
    let textBody: string | null = null;
    let htmlBody: string | null = null;
    let rawSize = 0;

    if (contentType.includes("application/json")) {
      const body = await request.json();
      toAddress = (body.to || body.toAddress || body.recipient || "").toLowerCase().trim();
      fromAddress = (body.from || body.fromAddress || body.sender || "").toLowerCase().trim();
      fromName = body.fromName || null;
      subject = body.subject || "(No Subject)";
      textBody = body.text || body.textBody || null;
      htmlBody = body.html || body.htmlBody || null;
      rawSize = JSON.stringify(body).length;
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      toAddress = (formData.get("to") as string || "").toLowerCase().trim();
      fromAddress = (formData.get("from") as string || "").toLowerCase().trim();
      subject = (formData.get("subject") as string || "(No Subject)");
      textBody = formData.get("text") as string || null;
      htmlBody = formData.get("html") as string || null;
      rawSize = (textBody?.length || 0) + (htmlBody?.length || 0);
    } else {
      // Raw stream or MIME format
      const rawText = await request.text();
      rawSize = rawText.length;
      const parsed = parseMimeEmail(rawText);
      toAddress = parsed.toAddress;
      fromAddress = parsed.fromAddress;
      fromName = parsed.fromName;
      subject = parsed.subject;
      textBody = parsed.textBody;
      htmlBody = parsed.htmlBody;
    }

    if (!toAddress) {
      toAddress = "support@fmv.lol";
    }

    // Find or automatically create mailbox for this domain address
    let mailbox = await db.mailbox.findFirst({
      where: { address: { equals: toAddress, mode: "insensitive" } },
    });

    if (!mailbox && toAddress.endsWith("@fmv.lol")) {
      const localPart = toAddress.split("@")[0];
      const friendlyName = localPart.charAt(0).toUpperCase() + localPart.slice(1);
      mailbox = await db.mailbox.create({
        data: {
          address: toAddress,
          name: `${friendlyName} Desk`,
        },
      });
    }

    const createdEmail = await db.inboundEmail.create({
      data: {
        mailboxId: mailbox?.id || null,
        toAddress,
        fromAddress: fromAddress || "unknown@external.com",
        fromName,
        subject,
        textBody,
        htmlBody,
        rawSize,
      },
    });

    return new Response(JSON.stringify({ success: true, emailId: createdEmail.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error processing inbound email webhook:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
