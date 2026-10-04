# GhostSync Shopify App Store Listing Copy & Metadata

## Basic Information
- **App Name:** GhostSync
- **App Subtitle:** Real-Time Multi-Store Inventory & Price Sync Engine
- **Target Category:** Inventory management & multi-channel selling

## Performance-Based Pricing (Cheaper than Syncio)
- **Free Tier (0 – 25 Synced Orders / mo):** $0/month (Free forever up to 25 orders with synced products, connect 2 stores, unlimited SKUs).
- **Starter Tier (26 – 150 Synced Orders / mo):** $9/month *(vs. Syncio $19/mo — Save 53%)* - Up to 4 stores, SpeedSurge flash mode, Drift Doctor auto-heal.
- **Pro Growth Tier (151 – 1,500 Synced Orders / mo):** $29/month *(vs. Syncio $49/mo — Save 41%)* - Unlimited stores, Safety Stock Buffers, Wholesale Pricing engine, Cross-Store Order Forwarding.
- **Enterprise Tier (1,501 – 10,000+ Synced Orders / mo):** $59/month *(vs. Syncio $99/mo — Save 40%)* - High-volume scale SLA, dedicated Raspberry Pi cluster support.

## App URLs
- **App URL:** https://app.fmv.lol
- **Privacy Policy URL:** https://app.fmv.lol/privacy
- **Terms of Service URL:** https://app.fmv.lol/terms
- **Support URL:** https://app.fmv.lol/support
- **Support Email:** support@fmv.lol

## Mandatory GDPR Endpoints
- **Customer data request:** https://app.fmv.lol/webhooks/customers/data_request
- **Customer data deletion:** https://app.fmv.lol/webhooks/customers/redact
- **Shop data erasure:** https://app.fmv.lol/webhooks/shop/redact

## Key Features & Bullet Points
1. **SpeedSurge Bi-Directional Webhook Sync:** Sub-500ms inventory synchronization across all connected storefronts to prevent overselling.
2. **Multi-Store Network Hub:** Link and coordinate unlimited secondary and satellite stores from one centralized primary dashboard.
3. **Safety Stock Buffers:** Protect against flash sales and wholesale depletion by reserving customized stock minimums per SKU.
4. **Drift Doctor Telemetry & Auto-Heal:** Live discrepancy scanner that flags stock misalignments and restores synchronization with 1 click.
5. **Wholesale Pricing Multipliers:** Automatically propagate percentage discounts or custom price rules to satellite B2B and wholesale stores.

## Hardware Host Specifications
- **Hosting Infrastructure:** Physical Dedicated Raspberry Pi 3 Host (24/7 dedicated compute)
- **Database:** Native PostgreSQL 17 cluster
- **Security & Networking:** Cloudflare Zero Trust Tunnel with Edge SSL (TLS 1.3), QUIC protocol, automated systemd recovery.
