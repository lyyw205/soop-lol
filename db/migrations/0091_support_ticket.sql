-- 비공개 건의·문의. 공개 뷰/정책을 만들지 않는다. 회원 탈퇴 시 본문까지 즉시 삭제한다.
CREATE TABLE support_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('suggestion', 'inquiry')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  reply text CHECK (char_length(reply) BETWEEN 1 AND 5000),
  answered_by uuid REFERENCES member(id),
  answered_at timestamptz,
  CHECK ((reply IS NULL AND answered_by IS NULL AND answered_at IS NULL)
      OR (reply IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL))
);
CREATE INDEX support_ticket_author_idx ON support_ticket(author_id, created_at DESC, id);
CREATE INDEX support_ticket_queue_idx ON support_ticket(created_at DESC, id);
ALTER TABLE support_ticket ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION erase_withdrawn_support() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'withdrawn' THEN
    DELETE FROM support_ticket WHERE author_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_erase_support AFTER UPDATE OF status ON member
FOR EACH ROW WHEN (NEW.status = 'withdrawn') EXECUTE FUNCTION erase_withdrawn_support();
