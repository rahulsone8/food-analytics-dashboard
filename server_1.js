/**
 * Food Analytics Dashboard — Express API  v4.0
 * ─────────────────────────────────────────────────────────────────────
 * ALL table/column names verified against pipeline.py v3.0
 *
 * Tables & exact columns written by pipeline:
 *
 *  dim_restaurants
 *    shop_id, restaurant_name, seller_name, city, pincode
 *    (NO: active, category)
 *
 *  dim_customers
 *    customer_contact, customer_name, platform
 *    (NOT a segment table — segments live in agg_customer_behavior)
 *
 *  fact_orders
 *    order_id, created_at, order_value, order_status, customer_name,
 *    customer_contact, delivery_type, discount, delivery_pincode, shop_id,
 *    channel, logistics_provider, logistics_price, gf_price,
 *    cancelled_by, cancellation_remark, delivery_distance,
 *    packing_charge, delivery_charge, convenience_charge,
 *    menu_discount, cart_discount, coupon_value, tax,
 *    platform, restaurant_name,
 *    order_date, order_year, order_month, order_month_name,
 *    order_week, order_hour, order_dow,
 *    net_revenue, is_cancelled (bool→tinyint), has_coupon (bool→tinyint)
 *
 *  fact_order_items
 *    order_id, product_name, platform
 *    (NO: shop_id, quantity, unit_price — not in pipeline)
 *
 *  fact_funnel
 *    action, timestamp_raw, customer_number, shop_id,
 *    timestamp, customer_contact,
 *    event_date, event_hour, event_month, event_month_name,
 *    event_dow, action_order, row_id
 *    (NO: stage_name, event_count)
 *
 *  agg_platform_daily
 *    platform, order_date,
 *    gmv, net_revenue, order_count, avg_order_value,
 *    discount_given, coupon_orders, cancelled_count, cancellation_rate
 *
 *  agg_restaurant_daily
 *    restaurant_name, shop_id, platform, order_date,
 *    gmv, net_revenue, order_count, avg_order_value,
 *    discount_given, coupon_orders, cancelled_count, cancellation_rate
 *
 *  agg_funnel_conversion
 *    shop_id, event_date,
 *    pdp_views, plp_views, cart_views, checkouts, orders_placed,
 *    plp_to_cart_rate, cart_to_checkout_rate,
 *    checkout_to_order_rate, overall_conversion_rate
 *    (NO: platform column)
 *
 *  agg_customer_behavior
 *    customer_contact, total_orders, total_gmv, avg_order_value,
 *    total_discount, first_order_date, last_order_date,
 *    platforms_used, cancelled_orders, coupon_usage,
 *    customer_segment, cancellation_rate
 *
 * Platform label values (from detect_platform in pipeline):
 *   "grabfood_whatsapp"   ← GF prefix
 *   "swayo_whatsapp"      ← SWWA prefix
 *   "swayo_app"           ← SWYO prefix
 *
 * DB name: funnel_pipeline  (from DB_URL in pipeline)
 * ─────────────────────────────────────────────────────────────────────
 * Install:  npm install express mysql2 cors dotenv
 * Run:      node server.js
 */

require("dotenv").config();
const express = require("express");
const mysql   = require("mysql2/promise");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // put dashboard.html in ./public/

// ── DB POOL ──────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:             process.env.DB_HOST || "localhost",
  port:             process.env.DB_PORT || 3306,
  user:             process.env.DB_USER || "root",
  password:         process.env.DB_PASS || "Rahul1975",   // matches pipeline DB_URL
  database:         process.env.DB_NAME || "funnel_pipeline",
  waitForConnections: true,
  connectionLimit:  10,
});

async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ── FILTER BUILDER for fact_orders (alias fo) ────────────────────────────────
// order_date is a Python date → stored as DATE in MySQL ✓
// order_dow  is a string like "Monday" (from dt.day_name()) — no numeric sort
function ordersWhere(query) {
  const c = ["1=1"], v = [];
  if (query.from)     { c.push("fo.order_date >= ?"); v.push(query.from); }
  if (query.to)       { c.push("fo.order_date <= ?"); v.push(query.to);   }
  if (query.platform) { c.push("fo.platform = ?");    v.push(query.platform); }
  if (query.shop_id)  { c.push("fo.shop_id = ?");     v.push(query.shop_id);  }
  return { where: c.join(" AND "), vals: v };
}

function buildWhere(query, alias) {
  const p = alias ? alias + "." : "";
  const c = ["1=1"], v = [];
  if (query.from)     { c.push(`${p}order_date >= ?`); v.push(query.from); }
  if (query.to)       { c.push(`${p}order_date <= ?`); v.push(query.to);   }
  if (query.platform) { c.push(`${p}platform = ?`);    v.push(query.platform); }
  if (query.shop_id)  { c.push(`${p}shop_id = ?`);     v.push(query.shop_id);  }
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
//  FILTERS — populate UI dropdowns
//  dim_restaurants has: shop_id, restaurant_name, city  (NO active/category)
//  platform values: grabfood_whatsapp | swayo_whatsapp | swayo_app
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/filters", async (_, res) => {
  try {
    const restaurants = await q(`
      SELECT shop_id, restaurant_name, city
      FROM dim_restaurants
      ORDER BY restaurant_name`);

    const platforms = await q(`
      SELECT DISTINCT platform FROM fact_orders
      WHERE platform IS NOT NULL AND platform != 'unknown'
      ORDER BY platform`);

    res.json({ restaurants, platforms: platforms.map(p => p.platform) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW
//  fact_orders columns used:
//    order_value (NOT gmv), net_revenue, is_cancelled, has_coupon,
//    coupon_value, menu_discount, cart_discount, packing_charge,
//    delivery_charge, tax, customer_contact, order_year, order_month,
//    order_dow (string "Monday"…), order_hour, delivery_type, platform
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/overview", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    // ── KPI strip ──────────────────────────────────────────────────────────
    const [kpis] = await q(`
      SELECT
        COALESCE(SUM(fo.order_value), 0)                                       AS total_gmv,
        COALESCE(SUM(fo.net_revenue), 0)                                       AS total_net_revenue,
        COUNT(*)                                                                AS total_orders,
        ROUND(AVG(fo.order_value), 2)                                          AS avg_order_value,
        SUM(fo.is_cancelled)                                                    AS cancelled_orders,
        ROUND(SUM(fo.is_cancelled)*100.0 / NULLIF(COUNT(*),0), 1)             AS cancel_rate,
        COUNT(DISTINCT fo.customer_contact)                                     AS unique_customers,
        SUM(fo.has_coupon)                                                      AS coupon_orders,
        ROUND(SUM(fo.has_coupon)*100.0 / NULLIF(COUNT(*),0), 1)               AS coupon_rate,
        COALESCE(SUM(fo.menu_discount), 0) + COALESCE(SUM(fo.cart_discount),0) AS total_discount,
        COALESCE(SUM(fo.packing_charge), 0)                                    AS total_packing,
        COALESCE(SUM(fo.delivery_charge), 0)                                   AS total_delivery,
        COALESCE(SUM(fo.tax), 0)                                               AS total_tax
      FROM fact_orders fo
      WHERE ${where}`, vals);

    // ── Monthly trend ──────────────────────────────────────────────────────
    // order_year, order_month stored as int by pipeline
    const monthly = await q(`
      SELECT
        fo.order_year,
        fo.order_month,
        CONCAT(fo.order_year, '-', LPAD(fo.order_month, 2, '0')) AS month_key,
        SUM(fo.order_value)  AS gmv,
        SUM(fo.net_revenue)  AS net_revenue,
        COUNT(*)             AS orders,
        ROUND(AVG(fo.order_value), 2) AS aov
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.order_year, fo.order_month
      ORDER BY fo.order_year, fo.order_month`, vals);

    // ── Platform share ─────────────────────────────────────────────────────
    const platforms = await q(`
      SELECT
        fo.platform,
        COUNT(*)                                                     AS orders,
        SUM(fo.order_value)                                          AS gmv,
        SUM(fo.net_revenue)                                          AS net_revenue,
        ROUND(AVG(fo.order_value), 2)                                AS aov,
        SUM(fo.is_cancelled)                                          AS cancelled,
        ROUND(SUM(fo.is_cancelled)*100.0/NULLIF(COUNT(*),0),1)      AS cancel_rate,
        ROUND(SUM(fo.has_coupon)*100.0/NULLIF(COUNT(*),0),1)        AS coupon_rate
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.platform
      ORDER BY orders DESC`, vals);

    // ── Day of week ────────────────────────────────────────────────────────
    // order_dow stored as string "Monday","Tuesday"... (dt.day_name())
    const dow = await q(`
      SELECT
        fo.order_dow,
        COUNT(*)              AS orders,
        SUM(fo.order_value)   AS gmv,
        ROUND(AVG(fo.order_value),2) AS aov
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.order_dow
      ORDER BY FIELD(fo.order_dow,
        'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
      vals);

    // ── Hour of day ────────────────────────────────────────────────────────
    const hourly = await q(`
      SELECT fo.order_hour, COUNT(*) AS orders, SUM(fo.order_value) AS gmv
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.order_hour
      ORDER BY fo.order_hour`, vals);

    // ── Delivery type × platform ───────────────────────────────────────────
    const delivery = await q(`
      SELECT fo.delivery_type, fo.platform, COUNT(*) AS cnt, SUM(fo.order_value) AS gmv
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.delivery_type, fo.platform
      ORDER BY cnt DESC`, vals);

    res.json({ kpis, monthly, platforms, dow, hourly, delivery });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  RESTAURANTS
//  agg_restaurant_daily columns: restaurant_name, shop_id, platform,
//    order_date, gmv, net_revenue, order_count, avg_order_value,
//    discount_given, coupon_orders, cancelled_count, cancellation_rate
//  dim_restaurants columns: shop_id, restaurant_name, city
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/restaurants", async (req, res) => {
  try {
    // Build WHERE for agg_restaurant_daily (alias a)
    const ac = ["1=1"], av = [];
    if (req.query.from)     { ac.push("a.order_date >= ?"); av.push(req.query.from); }
    if (req.query.to)       { ac.push("a.order_date <= ?"); av.push(req.query.to);   }
    if (req.query.platform) { ac.push("a.platform = ?");    av.push(req.query.platform); }
    if (req.query.shop_id)  { ac.push("a.shop_id = ?");     av.push(req.query.shop_id);  }
    const aWhere = ac.join(" AND ");

    // ── Try pre-computed agg_restaurant_daily first ────────────────────────
    // Uses restaurant_name (not a join — it's already denormalized in agg)
    const agg = await q(`
      SELECT
        a.shop_id,
        a.restaurant_name                                              AS name,
        r.city,
        SUM(a.order_count)                                             AS orders,
        SUM(a.gmv)                                                     AS gmv,
        SUM(a.net_revenue)                                             AS net_revenue,
        ROUND(SUM(a.gmv)/NULLIF(SUM(a.order_count),0), 2)            AS aov,
        SUM(a.cancelled_count)                                         AS cancelled,
        ROUND(SUM(a.cancelled_count)*100.0/NULLIF(SUM(a.order_count),0),1) AS cancel_rate,
        SUM(a.coupon_orders)                                           AS coupon_orders,
        SUM(a.discount_given)                                          AS total_discount
      FROM agg_restaurant_daily a
      LEFT JOIN dim_restaurants r ON r.shop_id = a.shop_id
      WHERE ${aWhere}
      GROUP BY a.shop_id, a.restaurant_name, r.city
      ORDER BY gmv DESC
      LIMIT 30`, av);

    if (agg.length > 0) {
      res.json({ top: agg, source: "agg_restaurant_daily" });
      return;
    }

    // ── Fallback: live fact_orders ─────────────────────────────────────────
    // restaurant_name is directly in fact_orders (denormalized by pipeline)
    const { where, vals } = ordersWhere(req.query);
    const live = await q(`
      SELECT
        fo.shop_id,
        fo.restaurant_name                                             AS name,
        r.city,
        COUNT(*)                                                       AS orders,
        SUM(fo.order_value)                                            AS gmv,
        SUM(fo.net_revenue)                                            AS net_revenue,
        ROUND(AVG(fo.order_value), 2)                                  AS aov,
        SUM(fo.is_cancelled)                                            AS cancelled,
        ROUND(SUM(fo.is_cancelled)*100.0/NULLIF(COUNT(*),0),1)        AS cancel_rate,
        SUM(fo.has_coupon)                                             AS coupon_orders,
        COALESCE(SUM(fo.menu_discount),0)+COALESCE(SUM(fo.cart_discount),0) AS total_discount
      FROM fact_orders fo
      LEFT JOIN dim_restaurants r ON r.shop_id = fo.shop_id
      WHERE ${where}
      GROUP BY fo.shop_id, fo.restaurant_name, r.city
      ORDER BY gmv DESC
      LIMIT 30`, vals);

    res.json({ top: live, source: "fact_orders" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  FUNNEL
//  fact_funnel columns: action, action_order, shop_id, customer_contact,
//    event_date, event_hour, event_month, event_dow, row_id
//    (action values: "PDP","PLP","VIEW_CART","CHECKOUT","ORDER")
//    (NO stage_name, NO event_count — each row is ONE event)
//
//  agg_funnel_conversion columns: shop_id, event_date,
//    pdp_views, plp_views, cart_views, checkouts, orders_placed,
//    plp_to_cart_rate, cart_to_checkout_rate,
//    checkout_to_order_rate, overall_conversion_rate
//    (NO platform column)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/funnel", async (req, res) => {
  try {
    const fc = ["1=1"], fv = [];
    if (req.query.from)    { fc.push("event_date >= ?"); fv.push(req.query.from); }
    if (req.query.to)      { fc.push("event_date <= ?"); fv.push(req.query.to);   }
    if (req.query.shop_id) { fc.push("shop_id = ?");     fv.push(req.query.shop_id); }
    // NOTE: fact_funnel has NO platform column — filter by shop_id only
    const fWhere = fc.join(" AND ");

    // ── Stage totals: COUNT rows per action (each row = 1 event) ──────────
    const stages = await q(`
      SELECT
        action_order,
        action                  AS stage_name,
        COUNT(*)                AS total
      FROM fact_funnel
      WHERE ${fWhere}
      GROUP BY action_order, action
      ORDER BY action_order`, fv);

    // ── Hourly drop-off ────────────────────────────────────────────────────
    const hourDrop = await q(`
      SELECT
        event_hour,
        action                  AS stage_name,
        action_order,
        COUNT(*)                AS total
      FROM fact_funnel
      WHERE ${fWhere}
      GROUP BY event_hour, action, action_order
      ORDER BY event_hour, action_order`, fv);

    // ── Pre-computed conversion from agg_funnel_conversion ─────────────────
    // No platform col — group by shop_id or roll up all
    const ac2 = ["1=1"], av2 = [];
    if (req.query.from)    { ac2.push("event_date >= ?"); av2.push(req.query.from); }
    if (req.query.to)      { ac2.push("event_date <= ?"); av2.push(req.query.to);   }
    if (req.query.shop_id) { ac2.push("shop_id = ?");     av2.push(req.query.shop_id); }

    const conv = await q(`
      SELECT
        SUM(pdp_views)                                    AS pdp_views,
        SUM(plp_views)                                    AS plp_views,
        SUM(cart_views)                                   AS cart_views,
        SUM(checkouts)                                    AS checkouts,
        SUM(orders_placed)                                AS orders_placed,
        ROUND(AVG(plp_to_cart_rate), 2)                  AS plp_to_cart_rate,
        ROUND(AVG(cart_to_checkout_rate), 2)             AS cart_to_checkout_rate,
        ROUND(AVG(checkout_to_order_rate), 2)            AS checkout_to_order_rate,
        ROUND(AVG(overall_conversion_rate), 2)           AS overall_conversion_rate
      FROM agg_funnel_conversion
      WHERE ${ac2.join(" AND ")}`, av2);

    res.json({ stages, hourDrop, conversion: conv[0] || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CUSTOMERS
//  agg_customer_behavior has ALL segment/behavioral data:
//    customer_contact, total_orders, total_gmv, avg_order_value,
//    total_discount, first_order_date, last_order_date,
//    platforms_used, cancelled_orders, coupon_usage,
//    customer_segment, cancellation_rate
//
//  dim_customers has ONLY: customer_contact, customer_name, platform
//  (no segment/GMV columns — those are in agg_customer_behavior)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/customers", async (req, res) => {
  try {
    // ── Segment counts from agg_customer_behavior (NOT dim_customers) ──────
    const segments = await q(`
      SELECT
        customer_segment,
        COUNT(*)                        AS cnt,
        SUM(total_gmv)                  AS gmv,
        ROUND(AVG(total_orders), 1)     AS avg_orders
      FROM agg_customer_behavior
      GROUP BY customer_segment
      ORDER BY FIELD(customer_segment,'VIP','Loyal','Repeat','One-time')`);

    // ── Top customers from agg_customer_behavior ───────────────────────────
    const top = await q(`
      SELECT
        cb.customer_contact,
        dc.customer_name,
        cb.customer_segment,
        cb.total_orders,
        cb.total_gmv,
        cb.first_order_date,
        cb.last_order_date,
        cb.platforms_used
      FROM agg_customer_behavior cb
      LEFT JOIN dim_customers dc ON dc.customer_contact = cb.customer_contact
      ORDER BY cb.total_orders DESC
      LIMIT 10`);

    // ── Coupon analysis from fact_orders ───────────────────────────────────
    const { where, vals } = ordersWhere(req.query);
    const coupon = await q(`
      SELECT
        fo.has_coupon,
        COUNT(*)                                                          AS orders,
        ROUND(AVG(fo.order_value), 2)                                    AS aov,
        ROUND(AVG(fo.net_revenue), 2)                                    AS avg_net,
        COALESCE(SUM(fo.menu_discount),0)+COALESCE(SUM(fo.cart_discount),0) AS total_discount
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.has_coupon`, vals);

    // ── Repeat vs new from agg_customer_behavior ───────────────────────────
    const repeatVsNew = await q(`
      SELECT
        CASE WHEN total_orders = 1 THEN 'new' ELSE 'repeat' END AS buyer_type,
        COUNT(*) AS customers,
        SUM(total_gmv) AS gmv
      FROM agg_customer_behavior
      GROUP BY buyer_type`);

    // ── Platform mix from dim_customers ───────────────────────────────────
    const platformMix = await q(`
      SELECT platform, COUNT(*) AS cnt
      FROM dim_customers
      GROUP BY platform ORDER BY cnt DESC`);

    res.json({ segments, top, coupon, repeatVsNew, platformMix });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  PRODUCTS
//  fact_order_items columns: order_id, product_name, platform
//  (NO shop_id, quantity, unit_price — not written by pipeline)
//
//  Join to fact_orders to get shop_id + restaurant_name
//  Platform values: grabfood_whatsapp | swayo_whatsapp | swayo_app
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/products", async (req, res) => {
  try {
    // Filter on fact_orders (fo) then join items (i)
    const { where, vals } = ordersWhere(req.query);
    // Rewrite alias for joined query
    const joinedWhere = where.replace(/fo\./g, "fo.");

    const allItems = await q(`
      SELECT
        i.platform,
        i.product_name,
        fo.shop_id,
        fo.restaurant_name,
        COUNT(*)     AS qty
      FROM fact_order_items i
      JOIN fact_orders fo ON fo.order_id = i.order_id
      WHERE ${joinedWhere}
      GROUP BY i.platform, i.product_name, fo.shop_id, fo.restaurant_name
      ORDER BY qty DESC`, vals);

    const totalLineItems = allItems.reduce((s, r) => s + Number(r.qty), 0);

    // Platform values from pipeline
    const appItems = allItems.filter(x => x.platform === "swayo_app").slice(0, 15);
    const gfItems  = allItems.filter(x => x.platform === "grabfood_whatsapp").slice(0, 10);
    const waItems  = allItems.filter(x => x.platform === "swayo_whatsapp").slice(0, 10);

    // Restaurant-level rollup
    const byRestaurant = await q(`
      SELECT
        fo.restaurant_name,
        fo.shop_id,
        COUNT(*)  AS qty
      FROM fact_order_items i
      JOIN fact_orders fo ON fo.order_id = i.order_id
      WHERE ${joinedWhere}
      GROUP BY fo.restaurant_name, fo.shop_id
      ORDER BY qty DESC
      LIMIT 15`, vals);

    res.json({ appItems, gfItems, waItems, byRestaurant, totalLineItems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  P&L  — uses full charge/discount columns from fact_orders
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/pnl", async (req, res) => {
  try {
    const { where, vals } = ordersWhere(req.query);

    const monthly = await q(`
      SELECT
        CONCAT(fo.order_year,'-',LPAD(fo.order_month,2,'0')) AS month_key,
        fo.order_year,
        fo.order_month,
        SUM(fo.order_value)                AS gmv,
        SUM(fo.net_revenue)                AS net_revenue,
        COALESCE(SUM(fo.menu_discount),0)  AS menu_discount,
        COALESCE(SUM(fo.cart_discount),0)  AS cart_discount,
        COALESCE(SUM(fo.coupon_value),0)   AS coupon_value,
        COALESCE(SUM(fo.packing_charge),0) AS packing_charge,
        COALESCE(SUM(fo.delivery_charge),0)AS delivery_charge,
        COALESCE(SUM(fo.convenience_charge),0) AS convenience_charge,
        COALESCE(SUM(fo.tax),0)            AS tax,
        COUNT(*)                           AS orders
      FROM fact_orders fo
      WHERE ${where}
      GROUP BY fo.order_year, fo.order_month
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
      FROM fact_orders fo
      WHERE ${where}`, vals);

    res.json({ monthly, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () =>
  console.log(`✅  Analytics API running → http://localhost:${PORT}`)
);