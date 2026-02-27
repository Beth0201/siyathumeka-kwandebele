// ============================================================
// SUPABASE CONFIG
// Replace these with your actual Supabase project credentials
// ============================================================
const SUPABASE_URL = 'https://lxpavqeoumswtkvkalbmx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4cGF2cWVvdW1zd3R2a2FsYm14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxODkyMjAsImV4cCI6MjA4Nzc2NTIyMH0.B-FugWtCKpT2xb61PQcAjPAjzyUAjYg7qvOzjQWPfXc';

// Only initialize if real keys are provided
if (SUPABASE_URL.includes('YOUR_PROJECT') || SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY')) {
  console.warn('⚠️ Supabase keys not set. Edit supabase.js and replace SUPABASE_URL and SUPABASE_ANON_KEY with your real credentials.');
  window._supabase = null;
} else {
  window._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ============================================================
// SUPABASE DATABASE SCHEMA (Run in Supabase SQL Editor)
// ============================================================
/*

-- PROFILES TABLE (extends auth.users)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  identity_number TEXT,
  citizenship TEXT DEFAULT 'SOUTH AFRICAN',
  phone TEXT,
  email TEXT,
  delivery_address TEXT,
  billing_address TEXT,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer','picker','driver','admin')),
  wallet_balance NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- STORES TABLE
CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  active BOOLEAN DEFAULT TRUE
);

INSERT INTO stores VALUES
  ('shoprite','SHOPRITE','LOWER PRICES YOU CAN TRUST, ALWAYS.',TRUE),
  ('shoprite-liquor','SHOPRITE LIQUOR','GREAT DEALS ON YOUR FAVORITE DRINKS.',TRUE),
  ('boxer','BOXER','NEVER PAY MORE THAN THE BOXER PRICE.',TRUE),
  ('spar','SPAR','GOOD FOR YOU.',TRUE),
  ('roots','ROOTS','QUALITY MEAT AND FRESH PRODUCE.',TRUE);

-- PRODUCTS TABLE
CREATE TABLE products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id TEXT REFERENCES stores(id),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price NUMERIC NOT NULL,
  image_url TEXT,
  uid TEXT UNIQUE,
  rating NUMERIC DEFAULT 4.0,
  stock INTEGER DEFAULT 100,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ORDERS TABLE
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_code TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES profiles(id),
  picker_id UUID REFERENCES profiles(id),
  driver_id UUID REFERENCES profiles(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','gathering','packed','in_transit','delivered','cancelled')),
  subtotal NUMERIC,
  vat NUMERIC,
  travel_fee NUMERIC,
  total NUMERIC,
  delivery_address TEXT,
  delivery_lat NUMERIC,
  delivery_lng NUMERIC,
  distance_km NUMERIC,
  waybill TEXT,
  citizen_first_name TEXT,
  citizen_last_name TEXT,
  citizen_phone TEXT,
  citizen_email TEXT,
  payment_method TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  packed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

-- ORDER ITEMS TABLE
CREATE TABLE order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  product_id UUID REFERENCES products(id),
  product_name TEXT,
  store_id TEXT,
  store_name TEXT,
  quantity INTEGER DEFAULT 1,
  price NUMERIC,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','found','missing'))
);

-- WALLET TRANSACTIONS TABLE
CREATE TABLE wallet_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  order_id UUID REFERENCES orders(id),
  type TEXT CHECK (type IN ('refund','earning','withdrawal','fee')),
  amount NUMERIC,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WITHDRAWAL REQUESTS TABLE
CREATE TABLE withdrawals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  amount NUMERIC,
  net_payout NUMERIC,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- ENABLE ROW LEVEL SECURITY
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;

-- RLS POLICIES (simplified for dev - tighten for production)
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Public can view stores" ON stores FOR SELECT USING (TRUE);
CREATE POLICY "Public can view products" ON products FOR SELECT USING (TRUE);
CREATE POLICY "Customers can view own orders" ON orders FOR SELECT USING (auth.uid() = customer_id);
CREATE POLICY "Staff can view all orders" ON orders FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('picker','driver','admin'))
);
CREATE POLICY "Customers can insert orders" ON orders FOR INSERT WITH CHECK (auth.uid() = customer_id);
CREATE POLICY "Staff can update orders" ON orders FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('picker','driver','admin'))
);
CREATE POLICY "Anyone can view order items for their order" ON order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM orders WHERE id = order_items.order_id AND (customer_id = auth.uid() OR
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('picker','driver','admin'))))
);
CREATE POLICY "Users can view own transactions" ON wallet_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own withdrawals" ON withdrawals FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can request withdrawals" ON withdrawals FOR INSERT WITH CHECK (auth.uid() = user_id);

-- SEED SAMPLE PRODUCTS
INSERT INTO products (store_id, name, description, category, price, uid, rating) VALUES
('shoprite-liquor','CARLING BLACK LABEL BEER 750ML','Champion Beer of South Africa.','Drinks',40.62,'SHOPRITE-LIQ-1',4.1),
('shoprite-liquor','CASTLE LAGER BEER 750ML','Brewed with the finest hops.','Drinks',76.69,'SHOPRITE-LIQ-2',4.3),
('shoprite','SASKO WHITE BREAD 700G','Freshly baked daily.','Bakery',18.99,'SHOPRITE-BAK-1',4.0),
('shoprite','FULL CREAM MILK 2L','Farm fresh full cream milk.','Fresh Food',32.50,'SHOPRITE-FF-1',4.5),
('boxer','CASTLE LAGER BEER 750ML','South Africa\'s favourite lager.','Drinks',78.30,'BOXER-DRK-1',4.2),
('spar','BULK BEEF T-BONE STEAK 1KG','Premium quality beef.','Fresh Food',90.78,'SPAR-FF-1',4.7),
('roots','FRESH CHICKEN BRAAI PACK 1KG','Free range local chicken.','Fresh Food',75.00,'ROOTS-FF-1',4.6),
('shoprite','SUNLIGHT DISHWASHING LIQUID 750ML','Cuts grease fast.','Household',29.99,'SHOPRITE-HH-1',4.1),
('boxer','SASKO CAKE FLOUR 2.5KG','Perfect for baking.','Bakery',42.00,'BOXER-BAK-1',4.0),
('spar','COCA COLA 2L','The original taste.','Drinks',28.99,'SPAR-DRK-1',4.8);
*/

// window._supabase is set above based on whether real keys are provided
