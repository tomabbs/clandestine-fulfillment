-- Storage bucket for product images (staff uploads).
-- Public read so Shopify can pull images by URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;
