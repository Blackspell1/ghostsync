export default function PrivacyPolicy() {
  return (
    <div style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', maxWidth: '800px', margin: '40px auto', padding: '24px', color: '#202223', lineHeight: '1.6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <span style={{ fontSize: '32px' }}>👻</span>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: '700' }}>GhostSync Privacy Policy</h1>
      </div>
      <p style={{ color: '#6d7175', fontSize: '14px' }}>Last updated: September 20, 2026</p>
      
      <hr style={{ border: 'none', borderTop: '1px solid #e1e3e5', margin: '24px 0' }} />

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>1. Introduction</h2>
      <p>
        GhostSync (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) provides a real-time multi-store inventory synchronization and management solution for Shopify merchants. We are committed to protecting your privacy and handling your data with complete transparency.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>2. Information We Collect</h2>
      <p>
        GhostSync is engineered with a privacy-by-design architecture. We only collect the minimal technical data required to synchronize inventory across your stores:
      </p>
      <ul>
        <li><strong>Store &amp; Inventory Data:</strong> Shopify store domains, location IDs, product variant IDs, SKUs, and inventory stock levels.</li>
        <li><strong>Sync Logs &amp; Telemetry:</strong> Records of inventory updates, sync timestamps, buffer thresholds, and latency metrics for operational auditing.</li>
        <li><strong>Authentication Credentials:</strong> Shopify OAuth access tokens necessary to communicate with the Shopify Admin API on your behalf.</li>
      </ul>
      <p>
        <strong>We DO NOT collect, store, or process any personal customer information (PII)</strong> such as customer names, physical addresses, email addresses, phone numbers, or payment/billing details.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>3. How We Use Information</h2>
      <p>GhostSync uses the collected technical data exclusively to:</p>
      <ul>
        <li>Mirror and calculate inventory adjustments across your linked Shopify stores in real time.</li>
        <li>Apply your configured Safety Stock Buffers, Wholesale Pricing rules, and SpeedSurge queue processing.</li>
        <li>Provide audit logs and discrepancy diagnosis within your GhostSync merchant dashboard.</li>
      </ul>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>4. Data Sharing &amp; Third Parties</h2>
      <p>
        We do not sell, rent, or monetize your store or inventory data. Data is transmitted exclusively between your authorized Shopify stores via encrypted connections (HTTPS / TLS 1.3).
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>5. GDPR &amp; CCPA Compliance</h2>
      <p>
        GhostSync fully complies with GDPR, CCPA, and Shopify&apos;s API Terms of Service. We support mandatory GDPR compliance webhooks (<code>customers/data_request</code>, <code>customers/redact</code>, and <code>shop/redact</code>). When you uninstall GhostSync, your store&apos;s sessions and sync records are automatically permanently deleted within 48 hours.
      </p>

      <h2 style={{ fontSize: '20px', fontWeight: '600' }}>6. Contact Us</h2>
      <p>
        If you have questions about this Privacy Policy or GhostSync data practices, please contact us at: <a href='mailto:support@fmv.lol' style={{ color: '#008060' }}>support@fmv.lol</a>.
      </p>
    </div>
  );
}