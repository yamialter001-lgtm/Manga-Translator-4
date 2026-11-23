#!/usr/bin/env bash
# ดาวน์โหลดฟอนต์ FiraGO (ไม่มีใน npm/Google Fonts) — ถ้าล้มเหลวจะไม่ทำให้ build พัง
# แอปจะใช้ Itim / Kodchasan แทน และผู้ใช้นำเข้าไฟล์ฟอนต์เองได้ในหน้าตั้งค่า
set +e
mkdir -p public/fonts
AUTH=()
[ -n "$GITHUB_TOKEN" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
REPO="bBoxType/FiraGO"
BR=$(curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO" | jq -r .default_branch 2>/dev/null)
{ [ -z "$BR" ] || [ "$BR" = "null" ]; } && BR=master
TREE=$(curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO/git/trees/$BR?recursive=1")
for W in Regular Bold; do
  P=$(echo "$TREE" | jq -r '.tree[].path' 2>/dev/null | grep -E "FiraGO-$W\.ttf$" | head -1)
  if [ -n "$P" ]; then
    curl -fsSL -o "public/fonts/FiraGO-$W.ttf" "https://raw.githubusercontent.com/$REPO/$BR/$P" \
      && echo "FiraGO-$W downloaded from $P" || echo "WARN: cannot download FiraGO-$W"
  else
    echo "WARN: FiraGO-$W.ttf not found in repo tree"
  fi
done
ls -la public/fonts
exit 0
