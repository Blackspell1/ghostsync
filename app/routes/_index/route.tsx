import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData, Link } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", minHeight: "100vh", background: "linear-gradient(180deg, #f7f9fa 0%, #ffffff 100%)", color: "#202223" }}>
      <header style={{ borderBottom: "1px solid #e1e3e5", background: "#ffffff", padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "28px" }}>👻</span>
          <span style={{ fontSize: "20px", fontWeight: 800, letterSpacing: "-0.5px" }}>GhostSync</span>
          <span style={{ background: "#e4e5e7", fontSize: "11px", fontWeight: 700, padding: "3px 8px", borderRadius: "12px", textTransform: "uppercase" }}>Production Server</span>
        </div>
        <nav style={{ display: "flex", gap: "24px", fontSize: "14px", fontWeight: 500 }}>
          <a href="#features" style={{ color: "#5c5f62", textDecoration: "none" }}>Features</a>
          <a href="#pricing" style={{ color: "#5c5f62", textDecoration: "none" }}>Pricing</a>
          <Link to="/support" style={{ color: "#5c5f62", textDecoration: "none" }}>Support</Link>
          <Link to="/privacy" style={{ color: "#5c5f62", textDecoration: "none" }}>Privacy</Link>
        </nav>
      </header>

      <main style={{ maxWidth: "1000px", margin: "60px auto", padding: "0 24px", textAlign: "center" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#f0f7f5", border: "1px solid #cbe5df", padding: "6px 14px", borderRadius: "20px", fontSize: "13px", fontWeight: 600, color: "#008060", marginBottom: "24px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#008060" }}></span>
          Live 24/7 Raspberry Pi Hardware Host &bull; Sub-Second Sync
        </div>
        
        <h1 style={{ fontSize: "48px", fontWeight: 800, letterSpacing: "-1px", lineHeight: 1.15, margin: "0 0 20px 0" }}>
          The Autonomous Multi-Store<br /><span style={{ color: "#008060" }}>Inventory Engine</span> for Shopify
        </h1>
        <p style={{ fontSize: "18px", color: "#6d7175", maxWidth: "680px", margin: "0 auto 36px auto", lineHeight: 1.5 }}>
          Never oversell across multiple Shopify stores again. Synchronize stock quantities instantly, safeguard inventory with safety buffers, and mirror wholesale prices effortlessly.
        </p>

        {showForm && (
          <div style={{ background: "#ffffff", padding: "32px", borderRadius: "16px", boxShadow: "0 4px 20px rgba(0,0,0,0.06)", border: "1px solid #e1e3e5", maxWidth: "480px", margin: "0 auto 60px auto" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px", fontWeight: 700 }}>Log In or Install GhostSync</h3>
            <Form method="post" action="/auth/login" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <label style={{ textAlign: "left", fontSize: "13px", fontWeight: 600, color: "#454f5b" }}>
                Shopify Domain:
                <input
                  type="text"
                  name="shop"
                  placeholder="your-store.myshopify.com"
                  required
                  style={{ width: "100%", padding: "12px 14px", marginTop: "6px", borderRadius: "8px", border: "1px solid #c9cccf", fontSize: "14px", boxSizing: "border-box" }}
                />
              </label>
              <button
                type="submit"
                style={{ background: "#008060", color: "#ffffff", border: "none", padding: "12px", borderRadius: "8px", fontSize: "15px", fontWeight: 600, cursor: "pointer", marginTop: "6px" }}
              >
                Connect Store &rarr;
              </button>
            </Form>
          </div>
        )}

        <div id="features" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "24px", textAlign: "left", marginTop: "60px" }}>
          <div style={{ background: "#ffffff", padding: "28px", borderRadius: "12px", border: "1px solid #e1e3e5" }}>
            <div style={{ fontSize: "28px", marginBottom: "12px" }}>⚡</div>
            <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px 0" }}>SpeedSurge Sync</h3>
            <p style={{ margin: 0, color: "#6d7175", fontSize: "14px", lineHeight: 1.5 }}>
              Instant bi-directional webhook synchronization across all your linked storefronts under 500ms.
            </p>
          </div>

          <div style={{ background: "#ffffff", padding: "28px", borderRadius: "12px", border: "1px solid #e1e3e5" }}>
            <div style={{ fontSize: "28px", marginBottom: "12px" }}>🛡️</div>
            <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px 0" }}>Safety Buffers</h3>
            <p style={{ margin: 0, color: "#6d7175", fontSize: "14px", lineHeight: 1.5 }}>
              Set custom reserve thresholds per SKU to prevent stockouts during viral flash sales and wholesale rushes.
            </p>
          </div>

          <div style={{ background: "#ffffff", padding: "28px", borderRadius: "12px", border: "1px solid #e1e3e5" }}>
            <div style={{ fontSize: "28px", marginBottom: "12px" }}>🩺</div>
            <h3 style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px 0" }}>Drift Doctor</h3>
            <p style={{ margin: 0, color: "#6d7175", fontSize: "14px", lineHeight: 1.5 }}>
              Automated discrepancy scanner that flags stock misalignments and self-heals inventory with 1 click.
            </p>
          </div>
        </div>

        {/* Performance-Based Pricing Section (Syncio-Style, Cheaper) */}
        <div id="pricing" style={{ marginTop: "80px", textAlign: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#fef3c7", border: "1px solid #fde68a", padding: "6px 14px", borderRadius: "20px", fontSize: "13px", fontWeight: 700, color: "#92400e", marginBottom: "16px" }}>
            <span>⚡</span> Performance-Based Source Store Pricing &bull; Cheaper than Syncio
          </div>
          <h2 style={{ fontSize: "36px", fontWeight: 800, margin: "0 0 12px 0", letterSpacing: "-0.5px" }}>Pay Only When You Sell</h2>
          <p style={{ color: "#6d7175", fontSize: "16px", maxWidth: "700px", margin: "0 auto 40px auto", lineHeight: 1.5 }}>
            GhostSync remains completely <strong>free for up to 25 orders with synced products each month</strong>. Your tier automatically scales with your monthly sales volume.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px", maxWidth: "1000px", margin: "0 auto", textAlign: "left" }}>
            {/* FREE TIER */}
            <div style={{ background: "#ffffff", padding: "28px", borderRadius: "16px", border: "1px solid #e1e3e5", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#008060", textTransform: "uppercase", letterSpacing: "0.5px" }}>Start Each Month Here</div>
                <h3 style={{ fontSize: "22px", fontWeight: 800, margin: "6px 0 12px 0" }}>Free</h3>
                <div style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 16px 0" }}>$0<span style={{ fontSize: "14px", fontWeight: 400, color: "#6d7175" }}> / mo</span></div>
                <div style={{ background: "#f6f6f7", padding: "10px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "16px" }}>
                  0 – 25 Orders <span style={{ fontWeight: 400, color: "#6d7175" }}>with synced products</span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "#454f5b", fontSize: "13px", lineHeight: "1.9" }}>
                  <li>✓ Connect 2 Stores</li>
                  <li>✓ Unlimited SKU Sync</li>
                  <li>✓ Sub-Second Webhook Sync</li>
                  <li>✓ Community Support</li>
                </ul>
              </div>
            </div>

            {/* STARTER TIER */}
            <div style={{ background: "#ffffff", padding: "28px", borderRadius: "16px", border: "1px solid #e1e3e5", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4f46e5", textTransform: "uppercase", letterSpacing: "0.5px" }}>Syncio: $19/mo</div>
                <h3 style={{ fontSize: "22px", fontWeight: 800, margin: "6px 0 12px 0" }}>Starter</h3>
                <div style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 16px 0" }}>$9<span style={{ fontSize: "14px", fontWeight: 400, color: "#6d7175" }}> / mo</span></div>
                <div style={{ background: "#f6f6f7", padding: "10px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "16px" }}>
                  26 – 150 Orders <span style={{ fontWeight: 400, color: "#6d7175" }}>with synced products</span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "#454f5b", fontSize: "13px", lineHeight: "1.9" }}>
                  <li>✓ Up to 4 Connected Stores</li>
                  <li>✓ SpeedSurge Flash Mode</li>
                  <li>✓ Drift Doctor Auto-Heal</li>
                  <li>✓ Fast Email Support</li>
                </ul>
              </div>
            </div>

            {/* PRO TIER (POPULAR) */}
            <div style={{ background: "#f0fdf4", padding: "28px", borderRadius: "16px", border: "2px solid #008060", position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", boxShadow: "0 8px 24px rgba(0,128,96,0.12)" }}>
              <div style={{ position: "absolute", top: "-12px", right: "20px", background: "#008060", color: "#ffffff", padding: "4px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: 800 }}>MOST POPULAR</div>
              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#008060", textTransform: "uppercase", letterSpacing: "0.5px" }}>Syncio: $49/mo</div>
                <h3 style={{ fontSize: "22px", fontWeight: 800, margin: "6px 0 12px 0" }}>Pro Growth</h3>
                <div style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 16px 0" }}>$29<span style={{ fontSize: "14px", fontWeight: 400, color: "#6d7175" }}> / mo</span></div>
                <div style={{ background: "#e6f4ea", padding: "10px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, color: "#008060", marginBottom: "16px" }}>
                  151 – 1,500 Orders <span style={{ fontWeight: 400, color: "#202223" }}>with synced products</span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "#202223", fontSize: "13px", lineHeight: "1.9" }}>
                  <li>✓ Unlimited Connected Stores</li>
                  <li>✓ Safety Stock Buffers per SKU</li>
                  <li>✓ Wholesale Pricing Engine</li>
                  <li>✓ Cross-Store Order Routing</li>
                  <li>✓ Priority Support & Telemetry</li>
                </ul>
              </div>
            </div>

            {/* ENTERPRISE TIER */}
            <div style={{ background: "#ffffff", padding: "28px", borderRadius: "16px", border: "1px solid #e1e3e5", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.5px" }}>Syncio: $99/mo</div>
                <h3 style={{ fontSize: "22px", fontWeight: 800, margin: "6px 0 12px 0" }}>Enterprise</h3>
                <div style={{ fontSize: "32px", fontWeight: 800, margin: "0 0 16px 0" }}>$59<span style={{ fontSize: "14px", fontWeight: 400, color: "#6d7175" }}> / mo</span></div>
                <div style={{ background: "#f6f6f7", padding: "10px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "16px" }}>
                  1,501 – 10,000+ Orders <span style={{ fontWeight: 400, color: "#6d7175" }}>with synced products</span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "#454f5b", fontSize: "13px", lineHeight: "1.9" }}>
                  <li>✓ High-Volume Multi-Store Networks</li>
                  <li>✓ Dedicated Raspberry Pi SLA</li>
                  <li>✓ Custom SKU Mapping Pipelines</li>
                  <li>✓ 1-on-1 Engineer Onboarding</li>
                </ul>
              </div>
            </div>
          </div>

          <p style={{ color: "#6d7175", fontSize: "13px", marginTop: "32px", fontStyle: "italic" }}>
            *What qualifies as an "order with synced products"? An order where a destination store sells an item synchronized with your Source Hub.
          </p>
        </div>
      </main>

      <footer style={{ borderTop: "1px solid #e1e3e5", background: "#ffffff", padding: "32px", marginTop: "100px", textAlign: "center", fontSize: "14px", color: "#6d7175" }}>
        <div style={{ display: "flex", justifyContent: "center", gap: "24px", marginBottom: "16px" }}>
          <Link to="/privacy" style={{ color: "#202223", textDecoration: "none" }}>Privacy Policy</Link>
          <Link to="/terms" style={{ color: "#202223", textDecoration: "none" }}>Terms of Service</Link>
          <Link to="/support" style={{ color: "#202223", textDecoration: "none" }}>Support Desk</Link>
        </div>
        <div>&copy; 2026 GhostSync. Powered by Raspberry Pi 3 Production Engine. All rights reserved.</div>
      </footer>
    </div>
  );
}
