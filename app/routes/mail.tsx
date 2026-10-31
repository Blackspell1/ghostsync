import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const selectedMailboxId = url.searchParams.get("box");
  const selectedEmailId = url.searchParams.get("email");

  const mailboxes = await db.mailbox.findMany({
    include: {
      _count: {
        select: { emails: true },
      },
    },
    orderBy: { id: "asc" },
  });

  const activeBox = selectedMailboxId
    ? mailboxes.find((m) => m.id === parseInt(selectedMailboxId, 10))
    : mailboxes[0];

  const emails = activeBox
    ? await db.inboundEmail.findMany({
        where: { mailboxId: activeBox.id },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const activeEmail = selectedEmailId
    ? emails.find((e) => e.id === parseInt(selectedEmailId, 10)) || emails[0]
    : emails[0];

  // Mark active email as read if not already
  if (activeEmail && !activeEmail.isRead) {
    await db.inboundEmail.update({
      where: { id: activeEmail.id },
      data: { isRead: true },
    });
    activeEmail.isRead = true;
  }

  return {
    mailboxes,
    activeBoxId: activeBox?.id || null,
    emails,
    activeEmailId: activeEmail?.id || null,
    activeEmail,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create-mailbox") {
    let name = (formData.get("name") as string || "").trim();
    let prefix = (formData.get("prefix") as string || "").trim().toLowerCase();

    // Clean prefix: allow only letters, numbers, dots, hyphens
    prefix = prefix.replace(/[^a-z0-9.-]/g, "");

    if (!prefix) {
      return { error: "Please provide a valid email name/prefix (e.g. sales, billing, vip)." };
    }

    const fullAddress = `${prefix}@fmv.lol`;
    if (!name) {
      name = prefix.charAt(0).toUpperCase() + prefix.slice(1) + " Inbox";
    }

    try {
      const existing = await db.mailbox.findUnique({
        where: { address: fullAddress },
      });

      if (existing) {
        return { error: `Mailbox ${fullAddress} already exists!` };
      }

      await db.mailbox.create({
        data: {
          address: fullAddress,
          name,
        },
      });

      return { success: `Successfully created ${fullAddress}!`, createdAddress: fullAddress };
    } catch (e: any) {
      return { error: e.message || "Failed to create mailbox" };
    }
  }

  if (intent === "delete-email") {
    const emailId = parseInt(formData.get("emailId") as string, 10);
    if (emailId) {
      await db.inboundEmail.delete({ where: { id: emailId } });
      return { success: "Email deleted." };
    }
  }

  if (intent === "send-test") {
    const toAddress = formData.get("toAddress") as string;
    const mailbox = await db.mailbox.findUnique({ where: { address: toAddress } });
    if (mailbox) {
      await db.inboundEmail.create({
        data: {
          mailboxId: mailbox.id,
          toAddress,
          fromAddress: "test-sender@example.com",
          fromName: "Demo Client",
          subject: `Test message to ${toAddress} at ${new Date().toLocaleTimeString()}`,
          textBody: `Hello! This is an automated test message sent directly to verify the real-time inbox viewer for ${toAddress}.\n\nEverything is operational!`,
          htmlBody: `<div style="font-family:sans-serif;padding:16px;background:#f4f6f8;border-radius:8px;"><h3>⚡ Test Email Received</h3><p>This confirms that <strong>${toAddress}</strong> is live and receiving messages.</p></div>`,
        },
      });
      return { success: `Sent simulated test email to ${toAddress}!` };
    }
  }

  return null;
};

export default function MailApp() {
  const { mailboxes, activeBoxId, emails, activeEmailId, activeEmail } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: string; error?: string; createdAddress?: string }>();
  const navigation = useNavigation();

  const [showNewModal, setShowNewModal] = useState(false);
  const [newPrefix, setNewPrefix] = useState("");
  const [newName, setNewName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const activeBox = mailboxes.find((m) => m.id === activeBoxId) || mailboxes[0];

  const filteredEmails = emails.filter((e) => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      e.subject.toLowerCase().includes(q) ||
      e.fromAddress.toLowerCase().includes(q) ||
      (e.fromName && e.fromName.toLowerCase().includes(q)) ||
      (e.textBody && e.textBody.toLowerCase().includes(q))
    );
  });

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", backgroundColor: "#0f172a", color: "#f8fafc", overflow: "hidden" }}>
      {/* SIDEBAR: Mailboxes */}
      <div style={{ width: "280px", backgroundColor: "#1e293b", borderRight: "1px solid #334155", display: "flex", flexDirection: "column" }}>
        {/* Brand / Title */}
        <div style={{ padding: "20px 16px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "24px" }}>📬</span>
            <div>
              <div style={{ fontWeight: "700", fontSize: "16px", letterSpacing: "-0.02em" }}>FMV Webmail</div>
              <div style={{ fontSize: "12px", color: "#94a3b8" }}>fmv.lol Mail Hub</div>
            </div>
          </div>
          <a href="/" style={{ color: "#38bdf8", fontSize: "12px", textDecoration: "none" }}>Back</a>
        </div>

        {/* Quick Action: New Mail Address */}
        <div style={{ padding: "16px" }}>
          <button
            onClick={() => setShowNewModal(true)}
            style={{
              width: "100%",
              padding: "10px 14px",
              backgroundColor: "#2563eb",
              hoverBackgroundColor: "#1d4ed8",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              fontWeight: "600",
              fontSize: "13px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            <span>+</span> Create New Email
          </button>
        </div>

        {/* Mailbox List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 12px" }}>
          <div style={{ fontSize: "11px", fontWeight: "700", color: "#64748b", textTransform: "uppercase", padding: "8px 8px 4px", letterSpacing: "0.05em" }}>
            Domain Inboxes ({mailboxes.length})
          </div>
          {mailboxes.map((box) => {
            const isSelected = box.id === activeBoxId;
            return (
              <a
                key={box.id}
                href={`/mail?box=${box.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  marginBottom: "4px",
                  textDecoration: "none",
                  backgroundColor: isSelected ? "#334155" : "transparent",
                  color: isSelected ? "#38bdf8" : "#cbd5e1",
                  fontWeight: isSelected ? "600" : "400",
                  fontSize: "13px",
                  transition: "background-color 0.15s",
                }}
              >
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <div style={{ color: isSelected ? "#f8fafc" : "#e2e8f0" }}>{box.address}</div>
                  <div style={{ fontSize: "11px", color: isSelected ? "#93c5fd" : "#64748b" }}>{box.name}</div>
                </div>
                <span
                  style={{
                    backgroundColor: isSelected ? "#1e293b" : "#334155",
                    color: isSelected ? "#38bdf8" : "#94a3b8",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontSize: "11px",
                    fontWeight: "600",
                  }}
                >
                  {box._count.emails}
                </span>
              </a>
            );
          })}
        </div>

        {/* Footer info */}
        <div style={{ padding: "14px 16px", borderTop: "1px solid #334155", fontSize: "11px", color: "#64748b" }}>
          Domain: <strong>fmv.lol</strong>
          <div style={{ color: "#10b981", marginTop: "2px" }}>● Inbound Worker Ready</div>
        </div>
      </div>

      {/* COLUMN 2: Message List */}
      <div style={{ width: "380px", backgroundColor: "#0f172a", borderRight: "1px solid #334155", display: "flex", flexDirection: "column" }}>
        {/* Header / Search */}
        <div style={{ padding: "16px", borderBottom: "1px solid #334155" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <div>
              <div style={{ fontWeight: "700", fontSize: "15px" }}>{activeBox?.address || "Inbox"}</div>
              <div style={{ fontSize: "12px", color: "#94a3b8" }}>{emails.length} messages received</div>
            </div>
            {/* Quick Test Email Button */}
            {activeBox && (
              <Form method="post" style={{ margin: 0 }}>
                <input type="hidden" name="intent" value="send-test" />
                <input type="hidden" name="toAddress" value={activeBox.address} />
                <button
                  type="submit"
                  title="Simulate incoming test email"
                  style={{
                    padding: "4px 8px",
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    color: "#94a3b8",
                    borderRadius: "6px",
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                >
                  ⚡ Send Test
                </button>
              </Form>
            )}
          </div>
          <input
            type="text"
            placeholder="Search emails..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              borderRadius: "6px",
              color: "#f8fafc",
              fontSize: "13px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Message rows */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filteredEmails.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>📭</div>
              <div style={{ fontWeight: "600", fontSize: "14px" }}>No emails in this inbox yet</div>
              <div style={{ fontSize: "12px", marginTop: "4px" }}>
                Send an email to <code>{activeBox?.address}</code> or click ⚡ Send Test above!
              </div>
            </div>
          ) : (
            filteredEmails.map((email) => {
              const isSelected = email.id === activeEmailId;
              const dateStr = new Date(email.createdAt).toLocaleDateString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });

              return (
                <a
                  key={email.id}
                  href={`/mail?box=${activeBoxId}&email=${email.id}`}
                  style={{
                    display: "block",
                    padding: "14px 16px",
                    borderBottom: "1px solid #1e293b",
                    textDecoration: "none",
                    backgroundColor: isSelected ? "#1e293b" : "transparent",
                    transition: "background-color 0.1s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "4px" }}>
                    <div style={{ fontWeight: email.isRead ? "500" : "700", color: email.isRead ? "#cbd5e1" : "#f8fafc", fontSize: "13px" }}>
                      {email.fromName || email.fromAddress}
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>{dateStr}</div>
                  </div>
                  <div style={{ fontWeight: email.isRead ? "400" : "600", fontSize: "13px", color: isSelected ? "#38bdf8" : "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "4px" }}>
                    {email.subject}
                  </div>
                  <div style={{ fontSize: "12px", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {email.textBody || "(HTML Content)"}
                  </div>
                </a>
              );
            })
          )}
        </div>
      </div>

      {/* COLUMN 3: Email Reader / Viewer */}
      <div style={{ flex: 1, backgroundColor: "#020617", display: "flex", flexDirection: "column" }}>
        {activeEmail ? (
          <>
            {/* Top Toolbar */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "20px" }}>✉️</span>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: "700", color: "#f8fafc" }}>{activeEmail.subject}</div>
                  <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
                    To: <strong style={{ color: "#38bdf8" }}>{activeEmail.toAddress}</strong>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px" }}>
                <Form method="post" style={{ margin: 0 }}>
                  <input type="hidden" name="intent" value="delete-email" />
                  <input type="hidden" name="emailId" value={activeEmail.id} />
                  <button
                    type="submit"
                    style={{
                      padding: "6px 12px",
                      backgroundColor: "#ef4444",
                      color: "#fff",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "12px",
                      cursor: "pointer",
                      fontWeight: "600",
                    }}
                  >
                    Delete
                  </button>
                </Form>
              </div>
            </div>

            {/* Sender / Meta info */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e293b", backgroundColor: "#0b0f19" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ width: "36px", height: "36px", borderRadius: "50%", backgroundColor: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: "14px", color: "#fff" }}>
                    {(activeEmail.fromName || activeEmail.fromAddress)[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: "600", color: "#f8fafc" }}>
                      {activeEmail.fromName ? `${activeEmail.fromName} <${activeEmail.fromAddress}>` : activeEmail.fromAddress}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      Received: {new Date(activeEmail.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Body */}
            <div style={{ flex: 1, padding: "24px", overflowY: "auto", color: "#e2e8f0", fontSize: "14px", lineHeight: "1.6" }}>
              {activeEmail.htmlBody ? (
                <div
                  style={{ backgroundColor: "#ffffff", color: "#111827", padding: "20px", borderRadius: "8px" }}
                  dangerouslySetInnerHTML={{ __html: activeEmail.htmlBody }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                  {activeEmail.textBody || "(Empty email message)"}
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column" }}>
            <span style={{ fontSize: "48px", marginBottom: "16px" }}>📬</span>
            <div style={{ fontSize: "16px", fontWeight: "600" }}>Select an email to read</div>
            <div style={{ fontSize: "13px", marginTop: "4px" }}>Choose from the inbox list on the left</div>
          </div>
        )}
      </div>

      {/* MODAL: Create New Mailbox */}
      {showNewModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "12px", width: "450px", padding: "24px", boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div style={{ fontSize: "18px", fontWeight: "700" }}>Create New Domain Email</div>
              <button
                onClick={() => setShowNewModal(false)}
                style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            {actionData?.error && (
              <div style={{ padding: "10px 12px", backgroundColor: "#ef444422", border: "1px solid #ef4444", borderRadius: "6px", color: "#fca5a5", fontSize: "12px", marginBottom: "16px" }}>
                {actionData.error}
              </div>
            )}

            <Form method="post" onSubmit={() => setShowNewModal(false)}>
              <input type="hidden" name="intent" value="create-mailbox" />

              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#cbd5e1", marginBottom: "6px" }}>
                  Email Address Name / Prefix
                </label>
                <div style={{ display: "flex", alignItems: "center", backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "6px", overflow: "hidden" }}>
                  <input
                    type="text"
                    name="prefix"
                    required
                    placeholder="e.g. sales, billing, vip, info"
                    value={newPrefix}
                    onChange={(e) => setNewPrefix(e.target.value)}
                    style={{ flex: 1, padding: "10px 12px", backgroundColor: "transparent", border: "none", color: "#f8fafc", fontSize: "14px", outline: "none" }}
                  />
                  <span style={{ padding: "10px 14px", backgroundColor: "#1e293b", color: "#38bdf8", fontWeight: "600", fontSize: "14px", borderLeft: "1px solid #334155" }}>
                    @fmv.lol
                  </span>
                </div>
                <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                  Resulting inbox: <strong>{newPrefix ? `${newPrefix.toLowerCase()}@fmv.lol` : "yourname@fmv.lol"}</strong>
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#cbd5e1", marginBottom: "6px" }}>
                  Friendly Label / Department (Optional)
                </label>
                <input
                  type="text"
                  name="name"
                  placeholder="e.g. Sales Department, VIP Concierge"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  style={{ width: "100%", padding: "10px 12px", backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: "6px", color: "#f8fafc", fontSize: "14px", outline: "none", boxSizing: "border-box" }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  style={{ padding: "8px 16px", backgroundColor: "transparent", border: "1px solid #475569", color: "#cbd5e1", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={navigation.state === "submitting"}
                  style={{ padding: "8px 20px", backgroundColor: "#2563eb", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: "pointer" }}
                >
                  {navigation.state === "submitting" ? "Creating..." : "Create Email"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
