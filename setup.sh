#!/usr/bin/env bash
# Cloud environment setup script for the jetcase careful read routine.
# Paste this into the environment's "Setup script" in claude.ai/code. It
# runs as root on Ubuntu and is cached, so it doesn't re-run every session.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# poppler-utils: pdftotext / pdftoppm / pdfinfo; tesseract: OCR;
# ocrmypdf + qpdf: OCR a whole scanned PDF in one go.
apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng ocrmypdf qpdf
node --version
