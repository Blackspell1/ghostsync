export default function TermsOfService() {
  return (
    <div style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', maxWidth: '800px', margin: '40px auto', padding: '24px', color: '#202223', lineHeight: '1.6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <span style={{ fontSize: '32px' }}>👻</span>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: '700' }}>GhostSync Terms of Service</h1>
      </div>
      <p style={{ color: '#6d7175', fontSize: '14px' }}>Last updated: September 20, 2026</p>
      
      <hr style={{ border: 'none', borderTop: '1px solid #e1e3e5', margin: '24px 0' }} />

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>1. Acceptance of Terms</h2>
      <p>
        By installing, connecting, or using the GhostSync application (&quot;the App&quot;), you agree to be bound by these Terms of Service. If you do not agree with any part of these terms, you may uninstall the application at any time.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>2. Description of Service</h2>
      <p>
        GhostSync provides automated inventory synchronization, safety stock management, multi-store networking, and price rule propagation between authorized Shopify storefronts.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>3. Performance-Based Subscriptions &amp; Billing</h2>
      <p>
        GhostSync operates on a performance-based tiered model based on monthly orders with synced products. Every store starts each monthly billing cycle on the Free Tier (0–25 orders free). If your store exceeds 25 synced orders, your store transitions into the appropriate performance tier (Starter $9/mo, Pro Growth $29/mo, Enterprise $59/mo). All billing is handled securely through Shopify&apos;s Native App Billing API.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>4. Merchant Responsibilities</h2>
      <p>
        You represent and warrant that you have the authority to connect the Shopify stores you link through GhostSync. You are responsible for configuring appropriate safety stock thresholds and pricing multipliers suited to your operations.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>5. Limitation of Liability</h2>
      <p>
        GhostSync strives for 99.9% sync accuracy and high reliability with sub-second propagation. However, GhostSync is provided &quot;as is&quot; and &quot;as available&quot;. In no event shall GhostSync or its developers be liable for indirect, incidental, or consequential damages resulting from inventory discrepancies or third-party carrier delays.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>6. Contact &amp; Inquiries</h2>
      <p>
        For inquiries regarding these terms, contact us at: <a href='mailto:support@fmv.lol' style={{ color: '#008060' }}>support@fmv.lol</a>.
      </p>
    </div>
  );
}