export default function SupportPage() {
  return (
    <div style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif', maxWidth: '800px', margin: '40px auto', padding: '24px', color: '#202223', lineHeight: '1.6' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <span style={{ fontSize: '32px' }}>👻</span>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', fontWeight: '700' }}>GhostSync Support &amp; Help Desk</h1>
          <p style={{ margin: '4px 0 0 0', color: '#6d7175', fontSize: '14px' }}>Fast, developer-grade support for your multi-store Shopify operations</p>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid #e1e3e5', margin: '24px 0' }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '32px' }}>
        <div style={{ background: '#f6f6f7', padding: '20px', borderRadius: '12px', border: '1px solid #e1e3e5' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>📧 Direct Email Support</h3>
          <p style={{ margin: '0 0 12px 0', color: '#6d7175', fontSize: '14px' }}>Get replies within 12 hours from our core engineering team.</p>
          <a href='mailto:support@fmv.lol' style={{ display: 'inline-block', background: '#008060', color: '#fff', textDecoration: 'none', padding: '10px 18px', borderRadius: '8px', fontWeight: '600', fontSize: '14px' }}>
            Email support@fmv.lol
          </a>
        </div>

        <div style={{ background: '#f6f6f7', padding: '20px', borderRadius: '12px', border: '1px solid #e1e3e5' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>⚡ Real-Time Health &amp; Status</h3>
          <p style={{ margin: '0 0 12px 0', color: '#6d7175', fontSize: '14px' }}>Operational uptime and webhook latency telemetry.</p>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: '#e3f1df', color: '#108043', padding: '6px 14px', borderRadius: '20px', fontWeight: '600', fontSize: '13px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#108043' }}></span> All Systems Operational
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px' }}>Frequently Asked Questions</h2>
      
      <div style={{ marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>How does GhostSync connect my stores?</h4>
        <p style={{ margin: 0, color: '#6d7175', fontSize: '14px' }}>
          GhostSync connects stores using standard Shopify OAuth and Webhooks. Simply install GhostSync on your primary store, enter your secondary store&apos;s domain in the Network Hub, and approve the connection.
        </p>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>What happens when an order is placed?</h4>
        <p style={{ margin: 0, color: '#6d7175', fontSize: '14px' }}>
          When an order is placed, Shopify immediately triggers an inventory level webhook. GhostSync processes this within milliseconds and updates inventory across all linked stores to eliminate overselling.
        </p>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Can I keep buffer stock on my secondary store?</h4>
        <p style={{ margin: 0, color: '#6d7175', fontSize: '14px' }}>
          Yes! With Safety Stock Buffers, you can specify reserve quantities per SKU (e.g. hold 5 units reserve on wholesale stores so you never deplete your retail stock).
        </p>
      </div>
    </div>
  );
}