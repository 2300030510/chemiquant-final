# ChemiQuant — Chemiluminometer Concentration Analyzer (CCA)

A full-stack Flask + SQLite web application for Chemiluminometer Concentration Analysis with precise 5 × 5 pixel ROI signal measurement, publication-quality calibration curve graphing, and automated concentration calculation.

## Guide-Directed Enhancements

1. **Exact Image Acquisition & 5 × 5 ROI Measurement Workflow**:
   - Step 1: Upload or acquire image (supports TIFF, PNG, JPG, GIF, MP4).
   - Step 2: Display acquired image on the interactive canvas.
   - Step 3: Manual selection is explicitly locked immediately after acquisition.
   - Step 4: Step-by-step guided measurement sequence:
     - Prominence set to **100**.
     - Open **ROI Manager**.
     - Click **Add**.
     - Select **More → Specify**.
     - Set ROI dimensions to **5 × 5 pixels** (Area: 25 pixels).
     - Manual ROI area positioning activated on image with real-time coordinate tracking and 10× pixel loupe.
     - Click **Measure**.
     - Calculate and clearly display the **Final Mean Intensity**.
   - Measurement results table displaying all 6 required parameters:
     - Image Name
     - ROI Area (25 pixels)
     - Mean Intensity
     - Standard Deviation
     - Minimum Intensity
     - Maximum Intensity

2. **Clean & Compact Error Management**:
   - Replaced disruptive browser alerts and cluttered error text with a sleek, non-intrusive alert banner.
   - Hidden by default; displays only when an actual issue occurs.
   - Deduplicated error messages with concise, understandable descriptions and auto-dismiss/close options.

3. **Publication-Quality Calibration Graphing**:
   - Clear, meaningful axis titles: **Concentration (units)** on X-axis and **C.L Intensity (a.u)** on Y-axis.
   - Beautifully spaced, readable tick marks and numerical values generated via a nice-numbers scaling algorithm.
   - High-DPI canvas rendering for crisp text and sharp lines.
   - Plotted data points rendered as distinct markers with fitted linear regression line.
   - Results tab displays sample placement directly on the calibration curve.

## Setup & Running Locally

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the application
python app.py
```
Open **http://localhost:5001** (or port specified by `PORT` env var).

## Deployment

### Option 1: Instant Public URL (Via Tunnel)
If your local server is running on port 5001, get an instant public HTTPS URL:
```bash
npx localtunnel --port 5001
# Or via SSH Pinggy (zero install):
ssh -p 443 -R0:localhost:5001 a.pinggy.io
```

### Option 2: Permanent Cloud Hosting (Render)
1. Push repository to GitHub.
2. Go to [Render Dashboard](https://dashboard.render.com/) -> **New Web Service**.
3. Connect repo — Render auto-detects `render.yaml` / `Procfile`.
4. Deploy to receive your permanent `https://chemiquant.onrender.com` URL.

### Option 3: Docker / Railway / Hugging Face Spaces
Build and run using the included `Dockerfile`:
```bash
docker build -t chemiquant .
docker run -p 5001:5001 chemiquant
```

## API Summary
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/library` | List all calibration curves (Malathion, Luminol/H₂O₂, etc.) |
| POST | `/api/calibration` | Save/re-fit a calibration curve from standards |
| POST | `/api/upload` | Upload image, TIFF, video, or GIF |
| GET | `/api/sample` | Load demo chemiluminescence sample image |
| GET | `/api/frame/<id>?prominence=100` | Extract and analyze frame with prominence threshold |
| POST | `/api/measure` | Measure 5 × 5 ROI (Area: 25 px, Mean, StdDev, Min, Max) |
| POST | `/api/predict` | Calculate concentration from measured mean intensity |
| GET | `/api/results` | Fetch recent prediction history |
| DELETE | `/api/results` | Clear all prediction history records |
| POST | `/api/email` | Send measurement result via SMTP or return client dispatch links |
| GET | `/api/email/status` | Check SMTP configuration status |
| POST | `/api/email/config` | Save SMTP credentials to `.env` and runtime environment |
| POST | `/api/email/test` | Test SMTP server connection and authentication |
