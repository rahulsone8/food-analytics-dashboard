# 🍽 Food Analytics Dashboard — Setup Guide

## Your Existing Schema (no changes needed)

| Table | Join Key | Used For |
|-------|----------|----------|
| `dim_restaurants` | `shop_id` | Restaurant name, category, city |
| `dim_customers` | `customer_contact` | Segment counts, top customers |
| `fact_orders` | — | All KPIs, trends, platform/DoW/hourly breakdowns |
| `fact_order_items` | — | Product page, category revenue |
| `fact_funnel` | — | Funnel waterfall, hourly drop-off |
| `agg_restaurant_daily` | `shop_id` | Pre-computed restaurant KPIs (zero Tableau SQL) |
| `agg_funnel_conversion` | — | Pre-computed conversion rates per platform |

## Columns Used from fact_orders

| Column | Used For |
|--------|----------|
| `order_date`, `order_year`, `order_month`, `order_week`, `order_hour`, `order_dow` | Trend charts, DoW bars, hourly heatmap |
| `net_revenue` | P&L page, platform net revenue |
| `is_cancelled` | Cancel rate KPI |
| `has_coupon` | Coupon adoption metric |
| `packing_charge`, `delivery_charge`, `menu_discount`, `cart_discount`, `tax` | P&L waterfall table |
| `shop_id` | Join to `dim_restaurants` |
| `customer_contact` | Join to `dim_customers` |
| `platform`, `delivery_type` | Platform split, delivery mix |

---

## Quick Start

### 1. Create .env
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=Rahul1975
DB_NAME=funnel_pipeline
PORT=3001
```

### 2. Install & Run
```bash
npm install express mysql2 cors dotenv
node server.js
# ✅  Analytics API running → http://localhost:3001
```

### 3. Open Dashboard
```
# Option A — open dashboard.html directly in browser
# Option B — serve it from Node (same origin, no CORS issues):
mkdir public && cp dashboard.html public/index.html
# then visit http://localhost:3001
```

---

## API Endpoints

All endpoints accept: `?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=swayo_app&shop_id=123`

| Endpoint | Tables Used | Returns |
|----------|-------------|---------|
| `GET /api/health` | — | DB status |
| `GET /api/filters` | `dim_restaurants`, `fact_orders` | Dropdown data |
| `GET /api/overview` | `fact_orders` | KPIs, monthly, platform, DoW, hourly, delivery |
| `GET /api/restaurants` | `agg_restaurant_daily` → fallback `fact_orders` + `dim_restaurants` | Top restaurants |
| `GET /api/funnel` | `agg_funnel_conversion`, `fact_funnel` | Stage totals, conversion rates, hourly drop-off |
| `GET /api/customers` | `dim_customers`, `fact_orders` | Segments, top list, coupon, new vs repeat |
| `GET /api/products` | `fact_order_items`, `dim_restaurants` | Top items per platform, category revenue |
| `GET /api/pnl` | `fact_orders` | Monthly P&L with all charge/discount/tax columns |

---

## Dashboard Pages

| Page | What It Shows |
|------|---------------|
| **Overview** | 5 KPIs · Monthly GMV trend · Platform donut · Day-of-week bars · Hourly bar chart · Delivery type mix |
| **Platforms** | Full comparison table (GMV, net revenue, AOV, cancel%, coupon%) · GMV share bars |
| **Restaurants** | Prefers `agg_restaurant_daily` (badge shows source) · GMV bars · Cancel/coupon per restaurant |
| **Funnel** | Waterfall from `fact_funnel.action_order` · Stage drop-offs · Hourly conversion heatmap · Platform conversion rates from `agg_funnel_conversion` |
| **Customers** | Segment grid from `dim_customers` · Coupon AOV comparison · New vs Repeat GMV split · Top customers table |
| **Products** | Top 15 App items · Top 10 GF WA items · Category revenue bars |
| **P&L** | Monthly table with GMV, discounts, packing, delivery, tax, net revenue · Cost waterfall chart |

---

## Auto-Refresh
Dashboard auto-refreshes every 60 seconds. Change in `dashboard.html`:
```js
setInterval(..., 60000); // milliseconds
```
