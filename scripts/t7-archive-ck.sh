#!/usr/bin/env bash
# soop-lol out/ck/<VOD> 실제 폴더를 T7(D:)로 옮기고 그 자리에 링크를 둔다. 2026-10-15 작성. 타이머(t7-archive-ck.timer)가 3시간마다 돌린다.
# 설치: scripts/systemd/install.sh --with-t7-archive (2026-10-16 ~/.local/bin 에서 저장소로 옮김 — 동작은 그대로)
# ★ 자동 조사(ck-auto.sh --work)도 회차 끝에 scripts/ck-archive.ts 로 같은 곳에 옮긴다. 그쪽은 조사 도장(done) 기준,
#   이쪽은 "6시간 동안 안 바뀐 폴더" 기준이라 자동 조사가 멈춰 있어도(백필만 돌 때도) C: 가 차지 않게 한다.
# ★ 옮겨도 C: 는 바로 늘지 않는다(WSL 가상 디스크가 안 줄어든다). 대신 비운 자리를 새 VOD 가 채워 가상 디스크가 더 커지지 않는다.
#   C: 를 실제로 돌려받으려면 fstrim + 가상 디스크 압축(diskpart compact vdisk)을 따로 한다.
# ★ 조사 중인 폴더는 건드리지 않는다 — 6시간 안에 바뀐 파일이 있거나, 백필이 지금 잡고 있는 VOD(current.json)면 건너뛴다.
# ★ 복사본의 파일 수·바이트 합이 원본과 같을 때만 원본을 지운다. 다르면 원본을 두고 실패로 센다.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/out/ck"
DST="${T7_ARCHIVE_DEST:-/mnt/d/soop-lol-ck}"
QUIET_MIN=${QUIET_MIN:-360}
exec 9>/tmp/t7-archive-ck.lock
flock -n 9 || { echo "이미 도는 중"; exit 0; }
ls "$DST" >/dev/null 2>&1 && touch "$DST/.probe" 2>/dev/null && rm -f "$DST/.probe" \
  || { echo "T7($DST)에 쓸 수 없다 — 연결 확인(sudo mount -t drvfs D: /mnt/d)"; exit 2; }
busy=" $(find "$SRC"/backfill -maxdepth 2 -name current.json -mmin -720 -exec grep -ho '"title_no": *[0-9]*' {} + 2>/dev/null | grep -o '[0-9]*' | tr '\n' ' ') "
ok=0; skip=0; bad=0
for d in $(find "$SRC" -maxdepth 1 -mindepth 1 -type d -regex '.*/[0-9]+' -printf '%f\n' | sort); do
  if [[ "$busy" == *" $d "* ]] || [[ -n "$(find "$SRC/$d" -mmin -"$QUIET_MIN" -print -quit)" ]]; then skip=$((skip+1)); continue; fi
  if [[ -e "$DST/$d" ]]; then echo "T7에 이미 있음 $d — 손으로 합칠 것"; bad=$((bad+1)); continue; fi
  rm -rf "$DST/$d.part"
  rsync -r --no-perms --no-owner --no-group "$SRC/$d/" "$DST/$d.part/" || { echo "복사 실패 $d"; bad=$((bad+1)); continue; }
  s="$(find "$SRC/$d" -type f -printf '%s\n' | awk '{n++;b+=$1}END{print n+0, b+0}')"
  t="$(find "$DST/$d.part" -type f -printf '%s\n' | awk '{n++;b+=$1}END{print n+0, b+0}')"
  if [[ "$s" == "$t" ]] && mv "$DST/$d.part" "$DST/$d" && rm -rf "$SRC/$d" && ln -s "$DST/$d" "$SRC/$d"; then ok=$((ok+1))
  else echo "불일치 $d 원본[$s] 복사[$t] — 원본 유지"; bad=$((bad+1)); fi
done
echo "$(date '+%F %T') 옮김 $ok · 조사 중이라 건너뜀 $skip · 실패 $bad · WSL 안 여유 $(df -h / | awk 'NR==2{print $4}') · C: 여유 $(df -h /mnt/c | awk 'NR==2{print $4}')"
(( bad == 0 ))
