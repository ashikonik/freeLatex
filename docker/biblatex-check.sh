#!/bin/sh
# Check that the image can build a biblatex document.
#
# Tectonic invokes biber by itself: it writes the control file, runs the
# program and reruns the engine. The only thing the image has to provide
# is the biber program on the PATH. This script proves that by building a
# small document that cites a book.
#
# It runs while the image is built, so a build that cannot do this fails
# here rather than in a reader's document.

set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/out"

cat > "$work/main.tex" <<'EOF'
\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
Hello \cite{knuth1984}.
\printbibliography
\end{document}
EOF

cat > "$work/refs.bib" <<'EOF'
@book{knuth1984, author={Knuth, Donald E.}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}
EOF

cd "$work"

output=$(XDG_CACHE_HOME=/home/freelatex/.cache tectonic -X compile main.tex --outfmt pdf --keep-intermediates --outdir out 2>&1) || {
  echo "the compilation failed:" >&2
  printf '%s\n' "$output" >&2
  exit 1
}

if ! printf '%s' "$output" | grep -q 'external tool biber'; then
  echo "the compiler did not invoke biber:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if [ ! -f out/main.pdf ]; then
  echo "the document was not built:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

# The bibliography itself has to be in the document. Without this check a
# document whose bibliography silently came out empty would still pass,
# because biber's failure is reported in the log rather than in the exit
# status of the compiler.
if ! grep -q 'Knuth' out/main.bbl 2>/dev/null; then
  echo "the bibliography was not written:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "a biblatex document builds: biber runs and the PDF is written"
