import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

// Quoted-Printable decoder
function decodeQP(input: string): string {
  if (!input) return "";
  const withoutSoft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoft.length; i++) {
    if (withoutSoft[i] === "=" && i + 2 < withoutSoft.length && /[0-9A-Fa-f]{2}/.test(withoutSoft.substring(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoft.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(withoutSoft.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

// RFC 2047 MIME Header decoder (=?UTF-8?Q?...?= or =?UTF-8?B?...?=)
function decodeMimeHeader(header: string | null | undefined): string {
  if (!header) return "";
  return header.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (match, charset, encoding, text) => {
    if (encoding.toUpperCase() === "B") {
      return Buffer.from(text, "base64").toString(charset.toLowerCase() === "utf-8" ? "utf-8" : "latin1");
    } else if (encoding.toUpperCase() === "Q") {
      return decodeQP(text.replace(/_/g, " "));
    }
    return match;
  });
}

// Robust MIME email parser for raw incoming emails
function parseMimeEmail(raw: string) {
  let fromAddress = "unknown@sender.com";
  let fromName: string | null = null;
  let toAddress = "inbox@fmv.lol";
  let subject = "(No Subject)";
  let textBody: string | null = null;
  let htmlBody: string | null = null;

  const headerEnd = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headerBlock = headerEnd !== -1 ? raw.substring(0, headerEnd) : raw;
  let bodyBlock = headerEnd !== -1 ? raw.substring(headerEnd).trim() : "";

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
      fromName = decodeMimeHeader(nameMatch[1].trim());
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
    subject = decodeMimeHeader(headers["subject"]);
  }

  // Check Transfer Encoding
  const isQP = (headers["content-transfer-encoding"] || "").toLowerCase().includes("quoted-printable") || bodyBlock.includes("=3D") || bodyBlock.includes("=C3=");

  // Extract boundaries if multipart
  const contentTypeHeader = headers["content-type"] || "";
  const boundaryMatch = contentTypeHeader.match(/boundary=["']?([^"';]+)["']?/i);

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = bodyBlock.split(new RegExp(`--${boundary}(?:--)?`));

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const partHeaderEnd = trimmed.indexOf("\r\n\r\n") !== -1 ? trimmed.indexOf("\r\n\r\n") : trimmed.indexOf("\n\n");
      const partHeaders = partHeaderEnd !== -1 ? trimmed.substring(0, partHeaderEnd).toLowerCase() : "";
      let partBody = partHeaderEnd !== -1 ? trimmed.substring(partHeaderEnd).trim() : trimmed;

      const partIsQP = partHeaders.includes("quoted-printable") || partBody.includes("=3D");
      if (partIsQP) {
        partBody = decodeQP(partBody);
      }

      if (partHeaders.includes("text/html")) {
        htmlBody = partBody;
      } else if (partHeaders.includes("text/plain") && !textBody) {
        textBody = partBody;
      }
    }
  } else {
    // Single part
    let decoded = isQP ? decodeQP(bodyBlock) : bodyBlock;
    if (contentTypeHeader.includes("text/html") || decoded.includes("<html") || decoded.includes("<!DOCTYPE") || decoded.includes("<table")) {
      htmlBody = decoded;
    } else {
      textBody = decoded;
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
    let toAddress = (request.headers.get("x-email-to") || "").toLowerCase().trim();
    let fromAddress = (request.headers.get("x-email-from") || "").toLowerCase().trim();
    let fromName: string | null = null;
    let subject = "(No Subject)";
    let textBody: string | null = null;
    let htmlBody: string | null = null;
    let rawSize = 0;

    if (contentType.includes("application/json")) {
      const body = await request.json();
      toAddress = (body.to || body.toAddress || body.recipient || toAddress).toLowerCase().trim();
      fromAddress = (body.from || body.fromAddress || body.sender || fromAddress).toLowerCase().trim();
      fromName = decodeMimeHeader(body.fromName || null);
      subject = decodeMimeHeader(body.subject || "(No Subject)");
      textBody = body.text || body.textBody || null;
      htmlBody = body.html || body.htmlBody || null;
      rawSize = JSON.stringify(body).length;
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      toAddress = (formData.get("to") as string || toAddress).toLowerCase().trim();
      fromAddress = (formData.get("from") as string || fromAddress).toLowerCase().trim();
      subject = decodeMimeHeader(formData.get("subject") as string || "(No Subject)");
      textBody = formData.get("text") as string || null;
      htmlBody = formData.get("html") as string || null;
      rawSize = (textBody?.length || 0) + (htmlBody?.length || 0);
    } else {
      // Raw MIME stream from Cloudflare Email Worker
      const rawText = await request.text();
      rawSize = rawText.length;
      const parsed = parseMimeEmail(rawText);
      if (!toAddress) toAddress = parsed.toAddress;
      if (!fromAddress) fromAddress = parsed.fromAddress;
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

    // If htmlBody contains quoted-printable artifacts, decode it
    if (htmlBody && (htmlBody.includes("=3D") || htmlBody.includes("=C3="))) {
      htmlBody = decodeQP(htmlBody);
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
