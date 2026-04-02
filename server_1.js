/**
 * Food Analytics API  v5.0
 * ─────────────────────────────────────────────────────────────────────
 * Fixes in v5:
 *  1. restaurant_name NULL  → COALESCE(fo.restaurant_name, r.restaurant_name, fo.shop_id)
 *  2. product_name NULL/bad → NULLIF / WHERE i.product_name NOT IN ('nan','none','')
 *  3. Default date range    → NO hardcoded dates; UI sends from/to based on actual data range
 *  4. /api/date_range       → returns MIN/MAX order_date so UI can auto-set pickers
 *  5. New endpoints for all 8 analytics requirements
 *
 * Exact column names from pipeline.py v3.0:
 *  fact_orders       : order_id, order_value, net_revenue, order_date,
 *                      order_year, order_month, order_month_name, order_week,
 *                      order_hour, order_dow, platform, shop_id, restaurant_name,
 *                      customer_contact, delivery_type, is_cancelled, has_coupon,
 *                      menu_discount, cart_discount, coupon_value,
 *                      packing_charge, delivery_charge, convenience_charge, tax
 *  fact_order_items  : order_id, product_name, platform
 *  fact_funnel       : action(PDP|PLP|VIEW_CART|CHECKOUT|ORDER), action_order(1-5),
 *                      shop_id, customer_contact, event_date, event_hour, event_dow
 *  dim_restaurants   : shop_id, restaurant_name, city, seller_name, pincode
 *  dim_customers     : customer_contact, customer_name, platform
 *  agg_customer_behavior: customer_contact, total_orders, total_gmv, avg_order_value,
 *                      total_discount, first_order_date, last_order_date,
 *                      platforms_used, cancelled_orders, coupon_usage,
 *                      customer_segment(VIP|Loyal|Repeat|One-time), cancellation_rate
 *  agg_restaurant_daily: restaurant_name, shop_id, platform, order_date,
 *                      gmv, net_revenue, order_count, avg_order_value,
 *                      discount_given, coupon_orders, cancelled_count, cancellation_rate
 *  agg_funnel_conversion: shop_id, event_date, pdp_views, plp_views, cart_views,
 *                      checkouts, orders_placed, plp_to_cart_rate,
 *                      cart_to_checkout_rate, checkout_to_order_rate, overall_conversion_rate
 *
 * Platform values  : "grabfood_whatsapp" | "swayo_whatsapp" | "swayo_app"
 * DB name          : funnel_pipeline
 */

require("dotenv").config();
const express = require("express");
const mysql   = require("mysql2/promise");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const pool = mysql.createPool({
  host:             process.env.DB_HOST || "localhost",
  port:             process.env.DB_PORT || 3306,
  user:             process.env.DB_USER || "root",
  password:         process.env.DB_PASS || "Rahul1975",
  database:         process.env.DB_NAME || "funnel_pipeline",
  waitForConnections: true,
  connectionLimit:  10,
});

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ── filter helpers ───────────────────────────────────────────────────────────
function ordersWhere(query) {
  const c = ["1=1"], v = [];
  if (query.from)     { c.push("fo.order_date >= ?"); v.push(query.from); }
  if (query.to)       { c.push("fo.order_date <= ?"); v.push(query.to);   }
  if (query.platform) { c.push("fo.platform = ?");    v.push(query.platform); }
  if (query.shop_id)  { c.push("fo.shop_id = ?");     v.push(query.shop_id); }
  return { where: c.join(" AND "), vals: v };
}

function plainWhere(query, alias) {
  const p = alias ? alias + "." : "";
  const c = ["1=1"], v = [];
  if (query.from)     { c.push(`${p}order_date >= ?`); v.push(query.from); }
  if (query.to)       { c.push(`${p}order_date <= ?`); v.push(query.to);   }
  if (query.platform) { c.push(`${p}platform = ?`);    v.push(query.platform); }
  if (query.shop_id)  { c.push(`${p}shop_id = ?`);     v.push(query.shop_id); }
  return { where: c.join(" AND "), vals: v };
}

// ════════════════════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/health", async (_, res) => {
  try {
    await pool.execute("SELECT 1");
    res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  DATE RANGE — returns actual min/max from fact_orders so UI can init pickers
//  No hardcoded dates anywhere — UI calls this first
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/date_range", async (_, res) => {
  try {
    const [row] = await q(`
      SELECT
        DATE_FORMAT(MIN(order_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(order_date), '%Y-%m-%d') AS max_date
      FROM fact_orders
      WHERE order_date IS NOT NULL`);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FILTERS — dropdowns; restaurant names resolved via dim_restaurants
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/filters", async (_, res) => {
  try {
    // All restaurants that ever appear in orders — name from dim first, fallback shop_id
    const restaurants = await q(`
      SELECT
        fo.shop_id,
        COALESCE(r.restaurant_name, fo.restaurant_name, fo.shop_id) AS restaurant_name
      FROM fact_orders fo
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE fo.shop_id IS NOT NULL
      GROUP BY fo.shop_id, r.restaurant_name, fo.restaurant_name
      ORDER BY restaurant_name`);

    const platforms = await q(`
      SELECT DISTINCT platform FROM fact_orders
      WHERE platform IS NOT NULL AND platform NOT IN ('unknown','')
      ORDER BY platform`);

    // Date range for initialising the date pickers in UI
    const [dr] = await q(`
      SELECT
        DATE_FORMAT(MIN(order_date),'%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(order_date),'%Y-%m-%d') AS max_date
      FROM fact_orders WHERE order_date IS NOT NULL`);

    res.json({ restaurants, platforms: platforms.map(p => p.platform), ...dr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW — KPIs + all trend charts
//  restaurant_name: COALESCE(fo.restaurant_name, r.restaurant_name, fo.shop_id)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/overview", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    const [kpis] = await q(`
      SELECT
        COALESCE(SUM(fo.order_value), 0)                                         AS total_gmv,
        COALESCE(SUM(fo.net_revenue), 0)                                         AS total_net_revenue,
        COUNT(*)                                                                  AS total_orders,
        ROUND(AVG(fo.order_value), 2)                                            AS avg_order_value,
        SUM(fo.is_cancelled)                                                      AS cancelled_orders,
        ROUND(SUM(fo.is_cancelled)*100.0/NULLIF(COUNT(*),0), 1)                 AS cancel_rate,
        COUNT(DISTINCT fo.customer_contact)                                       AS unique_customers,
        SUM(fo.has_coupon)                                                        AS coupon_orders,
        ROUND(SUM(fo.has_coupon)*100.0/NULLIF(COUNT(*),0), 1)                   AS coupon_rate,
        COALESCE(SUM(fo.menu_discount),0)+COALESCE(SUM(fo.cart_discount),0)     AS total_discount,
        COALESCE(SUM(fo.packing_charge),0)                                       AS total_packing,
        COALESCE(SUM(fo.delivery_charge),0)                                      AS total_delivery,
        COALESCE(SUM(fo.tax),0)                                                  AS total_tax
      FROM fact_orders fo WHERE ${where}`, vals);

    // ── 1. Orders Month-on-Month ─────────────────────────────────────────────
    const monthly = await q(`
      SELECT
        fo.order_year, fo.order_month,
        fo.order_month_name,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        COUNT(*)                          AS orders,
        SUM(fo.order_value)               AS gmv,
        SUM(fo.net_revenue)               AS net_revenue,
        ROUND(AVG(fo.order_value),2)      AS aov,
        COUNT(DISTINCT fo.customer_contact) AS unique_customers,
        SUM(fo.is_cancelled)               AS cancelled
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_year, fo.order_month, fo.order_month_name
      ORDER BY fo.order_year, fo.order_month`, vals);

    // ── 2. Orders Day-on-Day ─────────────────────────────────────────────────
    const daily = await q(`
      SELECT
        fo.order_date,
        COUNT(*)             AS orders,
        SUM(fo.order_value)  AS gmv,
        fo.order_dow         AS dow
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_date, fo.order_dow
      ORDER BY fo.order_date`, vals);

    // ── Day of week aggregate (which day has highest orders) ─────────────────
    const dow = await q(`
      SELECT
        fo.order_dow,
        COUNT(*) AS orders,
        SUM(fo.order_value) AS gmv,
        ROUND(AVG(fo.order_value),2) AS aov
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_dow
      ORDER BY FIELD(fo.order_dow,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`, vals);

    // ── Platform share ────────────────────────────────────────────────────────
    const platforms = await q(`
      SELECT
        fo.platform,
        COUNT(*)                                                      AS orders,
        SUM(fo.order_value)                                           AS gmv,
        SUM(fo.net_revenue)                                           AS net_revenue,
        ROUND(AVG(fo.order_value),2)                                  AS aov,
        SUM(fo.is_cancelled)                                           AS cancelled,
        ROUND(SUM(fo.is_cancelled)*100.0/NULLIF(COUNT(*),0),1)       AS cancel_rate,
        ROUND(SUM(fo.has_coupon)*100.0/NULLIF(COUNT(*),0),1)         AS coupon_rate
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.platform ORDER BY orders DESC`, vals);

    // ── Hour of day ───────────────────────────────────────────────────────────
    const hourly = await q(`
      SELECT fo.order_hour, COUNT(*) AS orders, SUM(fo.order_value) AS gmv
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_hour ORDER BY fo.order_hour`, vals);

    // ── Delivery type × platform ──────────────────────────────────────────────
    const delivery = await q(`
      SELECT fo.delivery_type, fo.platform, COUNT(*) AS cnt, SUM(fo.order_value) AS gmv
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.delivery_type, fo.platform ORDER BY cnt DESC`, vals);

    res.json({ kpis, monthly, daily, dow, platforms, hourly, delivery });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  RESTAURANTS  — name resolved via COALESCE
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/restaurants", async (req, res) => {
  try {
    const ac = ["1=1"], av = [];
    if (req.query.from)     { ac.push("a.order_date >= ?"); av.push(req.query.from); }
    if (req.query.to)       { ac.push("a.order_date <= ?"); av.push(req.query.to);   }
    if (req.query.platform) { ac.push("a.platform = ?");    av.push(req.query.platform); }
    if (req.query.shop_id)  { ac.push("a.shop_id = ?");     av.push(req.query.shop_id); }

    // Try agg_restaurant_daily (restaurant_name already there)
    const agg = await q(`
      SELECT
        a.shop_id,
        COALESCE(a.restaurant_name, r.restaurant_name, a.shop_id) AS name,
        r.city,
        SUM(a.order_count)   AS orders,
        SUM(a.gmv)           AS gmv,
        SUM(a.net_revenue)   AS net_revenue,
        ROUND(SUM(a.gmv)/NULLIF(SUM(a.order_count),0),2)  AS aov,
        SUM(a.cancelled_count)                              AS cancelled,
        ROUND(SUM(a.cancelled_count)*100.0/NULLIF(SUM(a.order_count),0),1) AS cancel_rate,
        SUM(a.coupon_orders) AS coupon_orders,
        SUM(a.discount_given) AS total_discount
      FROM agg_restaurant_daily a
      LEFT JOIN dim_restaurants r ON r.shop_id = a.shop_id
      WHERE ${ac.join(" AND ")}
      GROUP BY a.shop_id, a.restaurant_name, r.restaurant_name, r.city
      HAVING orders > 0
      ORDER BY gmv DESC LIMIT 40`, av);

    if (agg.length > 0) { res.json({ top: agg, source: "agg" }); return; }

    // Fallback to fact_orders with COALESCE for name
    const { where, vals } = ordersWhere(req.query);
    const live = await q(`
      SELECT
        fo.shop_id,
        COALESCE(r.restaurant_name, fo.restaurant_name, fo.shop_id) AS name,
        r.city,
        COUNT(*)               AS orders,
        SUM(fo.order_value)    AS gmv,
        SUM(fo.net_revenue)    AS net_revenue,
        ROUND(AVG(fo.order_value),2) AS aov,
        SUM(fo.is_cancelled)    AS cancelled,
        ROUND(SUM(fo.is_cancelled)*100.0/NULLIF(COUNT(*),0),1) AS cancel_rate,
        SUM(fo.has_coupon)     AS coupon_orders,
        COALESCE(SUM(fo.menu_discount),0)+COALESCE(SUM(fo.cart_discount),0) AS total_discount
      FROM fact_orders fo
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE ${where}
      GROUP BY fo.shop_id, r.restaurant_name, fo.restaurant_name, r.city
      HAVING orders > 0
      ORDER BY gmv DESC LIMIT 40`, vals);

    res.json({ top: live, source: "live" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FUNNEL
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/funnel", async (req, res) => {
  try {
    const fc = ["1=1"], fv = [];
    if (req.query.from)    { fc.push("event_date >= ?"); fv.push(req.query.from); }
    if (req.query.to)      { fc.push("event_date <= ?"); fv.push(req.query.to);   }
    if (req.query.shop_id) { fc.push("shop_id = ?");     fv.push(req.query.shop_id); }
    const fWhere = fc.join(" AND ");

    const stages = await q(`
      SELECT action_order, action AS stage_name, COUNT(*) AS total
      FROM fact_funnel WHERE ${fWhere}
      GROUP BY action_order, action ORDER BY action_order`, fv);

    const hourDrop = await q(`
      SELECT event_hour, action AS stage_name, action_order, COUNT(*) AS total
      FROM fact_funnel WHERE ${fWhere}
      GROUP BY event_hour, action, action_order ORDER BY event_hour, action_order`, fv);

    const ac2 = ["1=1"], av2 = [];
    if (req.query.from)    { ac2.push("event_date >= ?"); av2.push(req.query.from); }
    if (req.query.to)      { ac2.push("event_date <= ?"); av2.push(req.query.to);   }
    if (req.query.shop_id) { ac2.push("shop_id = ?");     av2.push(req.query.shop_id); }

    const [conv] = await q(`
      SELECT
        SUM(pdp_views) AS pdp_views, SUM(plp_views) AS plp_views,
        SUM(cart_views) AS cart_views, SUM(checkouts) AS checkouts,
        SUM(orders_placed) AS orders_placed,
        ROUND(AVG(plp_to_cart_rate),2) AS plp_to_cart_rate,
        ROUND(AVG(cart_to_checkout_rate),2) AS cart_to_checkout_rate,
        ROUND(AVG(checkout_to_order_rate),2) AS checkout_to_order_rate,
        ROUND(AVG(overall_conversion_rate),2) AS overall_conversion_rate
      FROM agg_funnel_conversion WHERE ${ac2.join(" AND ")}`, av2);

    res.json({ stages, hourDrop, conversion: conv || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CUSTOMERS — all 4 requirements:
//   • Segments from agg_customer_behavior
//   • Unique users month-on-month from fact_orders
//   • Total unique users across months
//   • Orders per user per month
//   • Orders per user across months
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/customers", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    // Segment summary
    const segments = await q(`
      SELECT customer_segment, COUNT(*) AS cnt, SUM(total_gmv) AS gmv,
             ROUND(AVG(total_orders),1) AS avg_orders
      FROM agg_customer_behavior
      GROUP BY customer_segment
      ORDER BY FIELD(customer_segment,'VIP','Loyal','Repeat','One-time')`);

    // Top 15 customers with name resolved
    const top = await q(`
      SELECT
        cb.customer_contact,
        COALESCE(dc.customer_name,'—') AS customer_name,
        cb.customer_segment, cb.total_orders, cb.total_gmv,
        cb.first_order_date, cb.last_order_date, cb.platforms_used,
        cb.coupon_usage, cb.cancellation_rate
      FROM agg_customer_behavior cb
      LEFT JOIN dim_customers dc ON dc.customer_contact = cb.customer_contact
      ORDER BY cb.total_orders DESC LIMIT 15`);

    // Coupon with vs without
    const coupon = await q(`
      SELECT fo.has_coupon, COUNT(*) AS orders,
             ROUND(AVG(fo.order_value),2) AS aov,
             COALESCE(SUM(fo.menu_discount),0)+COALESCE(SUM(fo.cart_discount),0) AS total_discount
      FROM fact_orders fo WHERE ${where} GROUP BY fo.has_coupon`, vals);

    // Repeat vs new
    const repeatVsNew = await q(`
      SELECT CASE WHEN total_orders=1 THEN 'new' ELSE 'repeat' END AS buyer_type,
             COUNT(*) AS customers, SUM(total_gmv) AS gmv
      FROM agg_customer_behavior GROUP BY buyer_type`);

    // ── REQ: Unique users month-on-month ─────────────────────────────────────
    const uniqueByMonth = await q(`
      SELECT
        fo.order_year, fo.order_month, fo.order_month_name,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        COUNT(DISTINCT fo.customer_contact) AS unique_users,
        COUNT(*) AS orders
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_year, fo.order_month, fo.order_month_name
      ORDER BY fo.order_year, fo.order_month`, vals);

    // ── REQ: Number of times a user orders per month (distribution) ──────────
    const ordersPerUserMonth = await q(`
      SELECT
        fo.order_year, fo.order_month,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        fo.customer_contact,
        COUNT(*) AS order_count
      FROM fact_orders fo
      WHERE ${where} AND fo.customer_contact IS NOT NULL
      GROUP BY fo.order_year, fo.order_month, fo.customer_contact
      ORDER BY fo.order_year, fo.order_month, order_count DESC`, vals);

    // ── REQ: Number of times a user orders across months (lifetime) ──────────
    const ordersPerUserTotal = await q(`
      SELECT
        cb.customer_contact,
        COALESCE(dc.customer_name,'—') AS customer_name,
        cb.customer_segment,
        cb.total_orders,
        cb.total_gmv,
        cb.first_order_date,
        cb.last_order_date
      FROM agg_customer_behavior cb
      LEFT JOIN dim_customers dc ON dc.customer_contact = cb.customer_contact
      ORDER BY cb.total_orders DESC LIMIT 50`);

    res.json({ segments, top, coupon, repeatVsNew, uniqueByMonth, ordersPerUserMonth, ordersPerUserTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  PRODUCTS — REQ: Top 10 items per month per restaurant
//  product_name nulls handled: filter out 'nan','none','',NULL
//  restaurant_name resolved via COALESCE
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/products", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    // All items — clean product names, restaurant from fact_orders COALESCE dim
    const allItems = await q(`
      SELECT
        i.platform,
        i.product_name,
        fo.shop_id,
        COALESCE(r.restaurant_name, fo.restaurant_name, fo.shop_id) AS restaurant_name,
        fo.order_year, fo.order_month,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        COUNT(*) AS qty
      FROM fact_order_items i
      JOIN fact_orders fo ON fo.order_id = i.order_id
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE ${where}
        AND i.product_name IS NOT NULL
        AND LOWER(TRIM(i.product_name)) NOT IN ('nan','none','null','','n/a')
        AND LENGTH(TRIM(i.product_name)) > 1
      GROUP BY i.platform, i.product_name, fo.shop_id,
               r.restaurant_name, fo.restaurant_name,
               fo.order_year, fo.order_month
      ORDER BY fo.order_year, fo.order_month, qty DESC`, vals);

    const totalLineItems = allItems.reduce((s, r) => s + Number(r.qty), 0);

    // Platform splits (overall top)
    const appItems = allItems.filter(x => x.platform === "swayo_app")
      .sort((a,b)=>b.qty-a.qty).slice(0, 15);
    const gfItems  = allItems.filter(x => x.platform === "grabfood_whatsapp")
      .sort((a,b)=>b.qty-a.qty).slice(0, 10);
    const waItems  = allItems.filter(x => x.platform === "swayo_whatsapp")
      .sort((a,b)=>b.qty-a.qty).slice(0, 10);

    // ── REQ: Top 10 items PER MONTH PER RESTAURANT ───────────────────────────
    // Group by restaurant+month, rank items within group
    const topByRestaurantMonth = await q(`
      SELECT
        fo.order_year, fo.order_month,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        COALESCE(r.restaurant_name, fo.restaurant_name, fo.shop_id) AS restaurant_name,
        fo.shop_id,
        i.product_name,
        COUNT(*) AS qty
      FROM fact_order_items i
      JOIN fact_orders fo ON fo.order_id = i.order_id
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE ${where}
        AND i.product_name IS NOT NULL
        AND LOWER(TRIM(i.product_name)) NOT IN ('nan','none','null','','n/a')
        AND LENGTH(TRIM(i.product_name)) > 1
      GROUP BY fo.order_year, fo.order_month, fo.shop_id,
               r.restaurant_name, fo.restaurant_name, i.product_name
      ORDER BY fo.order_year, fo.order_month,
               COALESCE(r.restaurant_name, fo.restaurant_name), qty DESC`, vals);

    // By restaurant total
    const byRestaurant = await q(`
      SELECT
        COALESCE(r.restaurant_name, fo.restaurant_name, fo.shop_id) AS restaurant_name,
        fo.shop_id, COUNT(*) AS qty
      FROM fact_order_items i
      JOIN fact_orders fo ON fo.order_id = i.order_id
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE ${where}
        AND i.product_name IS NOT NULL
        AND LOWER(TRIM(i.product_name)) NOT IN ('nan','none','null','','n/a')
      GROUP BY fo.shop_id, r.restaurant_name, fo.restaurant_name
      ORDER BY qty DESC LIMIT 20`, vals);

    res.json({ appItems, gfItems, waItems, byRestaurant, topByRestaurantMonth, totalLineItems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  P&L
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/pnl", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    const monthly = await q(`
      SELECT
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        fo.order_year, fo.order_month, fo.order_month_name,
        SUM(fo.order_value)                AS gmv,
        SUM(fo.net_revenue)                AS net_revenue,
        COALESCE(SUM(fo.menu_discount),0)  AS menu_discount,
        COALESCE(SUM(fo.cart_discount),0)  AS cart_discount,
        COALESCE(SUM(fo.coupon_value),0)   AS coupon_value,
        COALESCE(SUM(fo.packing_charge),0) AS packing_charge,
        COALESCE(SUM(fo.delivery_charge),0)AS delivery_charge,
        COALESCE(SUM(fo.convenience_charge),0) AS convenience_charge,
        COALESCE(SUM(fo.tax),0)            AS tax,
        COUNT(*) AS orders,
        ROUND(AVG(fo.order_value),2)       AS aov
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_year, fo.order_month, fo.order_month_name
      ORDER BY fo.order_year, fo.order_month`, vals);

    const [totals] = await q(`
      SELECT
        SUM(fo.order_value)                AS gmv,
        SUM(fo.net_revenue)                AS net_revenue,
        COALESCE(SUM(fo.menu_discount),0)  AS menu_discount,
        COALESCE(SUM(fo.cart_discount),0)  AS cart_discount,
        COALESCE(SUM(fo.coupon_value),0)   AS coupon_value,
        COALESCE(SUM(fo.packing_charge),0) AS packing_charge,
        COALESCE(SUM(fo.delivery_charge),0)AS delivery_charge,
        COALESCE(SUM(fo.convenience_charge),0) AS convenience_charge,
        COALESCE(SUM(fo.tax),0)            AS tax
      FROM fact_orders fo WHERE ${where}`, vals);

    res.json({ monthly, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AOV per month — food value only (order_value minus delivery/packing/tax)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/aov_monthly", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);
    const rows = await q(`
      SELECT
        fo.order_year, fo.order_month, fo.order_month_name,
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        fo.platform,
        COUNT(*) AS orders,
        ROUND(AVG(fo.order_value),2) AS aov_gross,
        ROUND(AVG(
          fo.order_value
          - COALESCE(fo.packing_charge,0)
          - COALESCE(fo.delivery_charge,0)
          - COALESCE(fo.convenience_charge,0)
          - COALESCE(fo.tax,0)
        ),2) AS aov_food_only
      FROM fact_orders fo WHERE ${where}
      GROUP BY fo.order_year, fo.order_month, fo.order_month_name, fo.platform
      ORDER BY fo.order_year, fo.order_month, fo.platform`, vals);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () =>
  console.log(`✅  Food Analytics API v5 → http://localhost:${PORT}`)
);