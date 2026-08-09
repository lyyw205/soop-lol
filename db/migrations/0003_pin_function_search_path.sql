-- search_path 고정 — 호출자의 search_path 에 따라 다른 객체가 잡히는 걸 막는다.

ALTER FUNCTION lol_lp_absolute(text, text, integer) SET search_path = pg_catalog, public;
ALTER FUNCTION touch_updated_at() SET search_path = pg_catalog, public;
