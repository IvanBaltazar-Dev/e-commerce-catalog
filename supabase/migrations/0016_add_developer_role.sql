-- Debe ejecutarse en una migración separada: PostgreSQL no permite usar un
-- valor nuevo de enum dentro de la misma transacción que lo agrega.
alter type public.app_role add value if not exists 'developer';
