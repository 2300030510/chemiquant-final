"""
ChemiQuant backend — Flask API for the Chemiluminometer Concentration Analyzer.
No authentication/login by design (per project requirement).

Run:
    pip install -r requirements.txt
    python app.py
Then open http://localhost:5001
"""
import os
import io
import json
import uuid
import base64
import smtplib
import urllib.parse
from email.mime.text import MIMEText
from datetime import datetime

import numpy as np
import cv2
from PIL import Image
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))  # reads .env next to this file, if present
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff")
UPLOAD_METADATA = {
    "005cbc353da9482eb481b42c36d93cec": {"filename": "Malathion_Calibration_Ref.tif"},
    "7a9504fe0bd54668a909a232d2aa9bf5": {"filename": "Malathion_Calibration_Ref.tif"}
}

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{os.path.join(BASE_DIR, 'chemiquant.db')}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB uploads
db = SQLAlchemy(app)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CalibrationCurve(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    analyte = db.Column(db.String(64), unique=True, nullable=False)
    units = db.Column(db.String(32), nullable=False, default="µM")
    points_json = db.Column(db.Text, nullable=False)  # [[conc, intensity], ...]
    slope = db.Column(db.Float)
    intercept = db.Column(db.Float)
    r2 = db.Column(db.Float)
    is_preset = db.Column(db.Boolean, default=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "analyte": self.analyte, "units": self.units,
            "points": json.loads(self.points_json),
            "slope": self.slope, "intercept": self.intercept, "r2": self.r2,
            "is_preset": self.is_preset,
        }


class Result(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    analyte = db.Column(db.String(64))
    units = db.Column(db.String(32))
    intensity = db.Column(db.Float)
    concentration = db.Column(db.Float)
    slope = db.Column(db.Float)
    intercept = db.Column(db.Float)
    r2 = db.Column(db.Float)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id, "analyte": self.analyte, "units": self.units,
            "intensity": self.intensity, "concentration": self.concentration,
            "slope": self.slope, "intercept": self.intercept, "r2": self.r2,
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M:%S UTC"),
        }


# ---------------------------------------------------------------------------
# Seed calibration library
# ---------------------------------------------------------------------------
LIBRARY_SEED = {
    "malathion":     {"units": "PPM",    "points": [[0, 88.5], [0.1, 78.2], [0.3, 71.6], [0.5, 65.4], [0.7, 60.9], [1.0, 51.5], [3.0, 41.6], [5.0, 32.7], [7.0, 25.1], [10.0, 17.3]]},
    "luminol_h2o2":  {"units": "µM",     "points": [[0, 4], [5, 22], [10, 41], [20, 78], [40, 151], [80, 244]]},
    "pesticide_cl":  {"units": "ppb",    "points": [[0, 6], [2, 19], [5, 38], [10, 66], [20, 120]]},
    "oil_rancidity": {"units": "meq/kg", "points": [[0, 10], [1, 28], [2, 49], [4, 88], [8, 160]]},
    "alp_upad":      {"units": "U/L",    "points": [[0, 3], [10, 30], [25, 65], [50, 118], [100, 220]]},
}


def fit_linear(points):
    """points: list of [concentration, intensity]. Fit concentration = m*I + b."""
    pts = np.array(points, dtype=float)
    X = pts[:, 1].reshape(-1, 1)   # intensity -> feature
    y = pts[:, 0]                  # concentration -> target
    model = LinearRegression().fit(X, y)
    pred = model.predict(X)
    r2 = r2_score(y, pred) if len(y) > 1 else 1.0
    return float(model.coef_[0]), float(model.intercept_), float(r2)


def seed_library():
    for key, cfg in LIBRARY_SEED.items():
        existing = CalibrationCurve.query.filter_by(analyte=key).first()
        if existing:
            continue
        m, b, r2 = fit_linear(cfg["points"])
        db.session.add(CalibrationCurve(
            analyte=key, units=cfg["units"], points_json=json.dumps(cfg["points"]),
            slope=m, intercept=b, r2=r2, is_preset=True,
        ))
    db.session.commit()


# ---------------------------------------------------------------------------
# Image / frame analysis
# ---------------------------------------------------------------------------
def analyze_rgb_array(arr):
    """arr: HxWx3 uint8 RGB. Returns (mean_intensity, peak, hotspot_pct)."""
    gray = np.dot(arr[..., :3].astype(float), [0.299, 0.587, 0.114])
    mean_intensity = float(gray.mean())
    peak = float(gray.max())
    hotspot_pct = float((gray > 180).sum()) / gray.size * 100
    return mean_intensity, peak, hotspot_pct


def array_to_data_url(arr, max_w=720):
    img = Image.fromarray(arr.astype("uint8"), "RGB")
    if img.width > max_w:
        h = int(img.height * (max_w / img.width))
        img = img.resize((max_w, h), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


def upload_path(upload_id):
    if upload_id == "sample_chemi":
        sample_path = os.path.join(BASE_DIR, "static", "sample_chemiluminescence.png")
        if os.path.exists(sample_path):
            return sample_path
    for fn in os.listdir(UPLOAD_DIR):
        if fn.startswith(upload_id):
            return os.path.join(UPLOAD_DIR, fn)
    return None


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes — API: upload + frame extraction (image / video / gif)
# ---------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
def api_upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file provided."), 400

    original_filename = os.path.basename(f.filename)
    ext = os.path.splitext(original_filename)[1].lower() or ".bin"
    upload_id = uuid.uuid4().hex
    saved_path = os.path.join(UPLOAD_DIR, upload_id + ext)
    f.save(saved_path)

    UPLOAD_METADATA[upload_id] = {
        "filename": original_filename,
        "ext": ext
    }

    kind = "video"
    meta = {}
    if ext in IMAGE_EXTENSIONS:
        kind = "image"
        with Image.open(saved_path) as img:
            meta["width"] = img.width
            meta["height"] = img.height
    elif ext == ".gif":
        kind = "gif"
        with Image.open(saved_path) as img:
            meta["frame_count"] = getattr(img, "n_frames", 1)
            meta["width"] = img.width
            meta["height"] = img.height
    else:
        cap = cv2.VideoCapture(saved_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        cap.release()
        meta["fps"] = fps
        meta["frame_count"] = frame_count
        meta["duration"] = (frame_count / fps) if fps else 0
        meta["width"] = w
        meta["height"] = h

    return jsonify(
        upload_id=upload_id,
        kind=kind,
        filename=original_filename,
        **meta
    )


@app.route("/api/sample", methods=["GET"])
def api_sample():
    """Returns sample chemiluminescence image for quick testing."""
    sample_path = os.path.join(BASE_DIR, "static", "sample_chemiluminescence.png")
    if not os.path.exists(sample_path):
        return jsonify(error="Sample image not found."), 404
    UPLOAD_METADATA["sample_chemi"] = {"filename": "chemiluminescence_sample.png", "ext": ".png"}
    with Image.open(sample_path) as img:
        w, h = img.width, img.height
    return jsonify(
        upload_id="sample_chemi",
        kind="image",
        filename="chemiluminescence_sample.png",
        width=w,
        height=h
    )


@app.route("/api/frame/<upload_id>", methods=["GET"])
def api_frame(upload_id):
    """Extract + analyze one frame. Query params: t=<seconds> (video) or
    frame=<index> (gif). No params -> whole still image."""
    path = upload_path(upload_id)
    if not path:
        return jsonify(error="Image not found."), 404
    ext = os.path.splitext(path)[1].lower()

    if ext in IMAGE_EXTENSIONS:
        arr = np.array(Image.open(path).convert("RGB"))
    elif ext == ".gif":
        idx = int(request.args.get("frame", 0))
        img = Image.open(path)
        img.seek(min(idx, getattr(img, "n_frames", 1) - 1))
        arr = np.array(img.convert("RGB"))
    else:
        t = float(request.args.get("t", 0))
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return jsonify(error="Could not read video frame."), 400
        arr = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    h, w = arr.shape[:2]
    mean_i, peak, hotspot = analyze_rgb_array(arr)
    meta_info = UPLOAD_METADATA.get(upload_id, {"filename": os.path.basename(path)})

    # Detect local peaks standing out above background
    # Prominence parameter (default 100)
    try:
        prominence = float(request.args.get("prominence", 100))
    except ValueError:
        prominence = 100.0

    gray = np.dot(arr[..., :3].astype(float), [0.299, 0.587, 0.114])
    peaks = []
    # Find simple local peaks if prominence threshold met
    if gray.size > 0:
        kernel = np.ones((5, 5), np.uint8)
        dilated = cv2.dilate(gray.astype(np.float32), kernel)
        local_max = (gray == dilated) & (gray >= prominence)
        y_idxs, x_idxs = np.where(local_max)
        for y, x in zip(y_idxs[:8], x_idxs[:8]):
            peaks.append({"x": int(x), "y": int(y), "intensity": round(float(gray[y, x]), 1)})

    return jsonify(
        preview=array_to_data_url(arr),
        mean_intensity=round(mean_i, 2),
        peak=round(peak, 1),
        hotspot_pct=round(hotspot, 1),
        width=w,
        height=h,
        filename=meta_info.get("filename", os.path.basename(path)),
        detected_peaks=peaks,
        prominence=prominence
    )


# ---------------------------------------------------------------------------
# Routes — API: exact 5x5 ROI measurement
# ---------------------------------------------------------------------------
@app.route("/api/measure", methods=["POST"])
def api_measure():
    """
    Measures a 5x5 ROI (25 pixels area) on the image.
    Returns:
      - Image name
      - ROI area (25 pixels)
      - Mean intensity
      - Standard deviation
      - Minimum intensity
      - Maximum intensity
    """
    body = request.get_json(force=True) or {}
    upload_id = body.get("upload_id")
    if not upload_id:
        return jsonify(error="Upload ID is required."), 400

    path = upload_path(upload_id)
    if not path:
        return jsonify(error="Image not found."), 404

    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTENSIONS:
        arr = np.array(Image.open(path).convert("RGB"))
    elif ext == ".gif":
        idx = int(body.get("frame", 0))
        img = Image.open(path)
        img.seek(min(idx, getattr(img, "n_frames", 1) - 1))
        arr = np.array(img.convert("RGB"))
    else:
        t = float(body.get("t", 0))
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, frame = cap.read()
        cap.release()
        if not ok:
            return jsonify(error="Could not read video frame."), 400
        arr = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    h, w = arr.shape[:2]
    gray = np.dot(arr[..., :3].astype(float), [0.299, 0.587, 0.114])

    roi_w = int(body.get("width", 5))
    roi_h = int(body.get("height", 5))
    if roi_w <= 0:
        roi_w = 5
    if roi_h <= 0:
        roi_h = 5

    x = int(round(float(body.get("x", 0))))
    y = int(round(float(body.get("y", 0))))

    # Clamp coordinates to ensure 5x5 ROI stays within image bounds
    x = max(0, min(x, max(0, w - roi_w)))
    y = max(0, min(y, max(0, h - roi_h)))

    patch = gray[y : y + roi_h, x : x + roi_w]
    area = int(patch.size)

    mean_val = float(np.mean(patch))
    std_val = float(np.std(patch, ddof=1)) if area > 1 else 0.0
    min_val = float(np.min(patch))
    max_val = float(np.max(patch))

    meta_info = UPLOAD_METADATA.get(upload_id, {"filename": os.path.basename(path)})
    filename = body.get("filename") or meta_info.get("filename", os.path.basename(path))

    return jsonify(
        image_name=filename,
        area=area,
        mean_intensity=round(mean_val, 2),
        std_dev=round(std_val, 2),
        min_intensity=round(min_val, 2),
        max_intensity=round(max_val, 2),
        roi_x=x,
        roi_y=y,
        roi_width=roi_w,
        roi_height=roi_h,
        patch_matrix=patch.round(1).tolist()
    )


# ---------------------------------------------------------------------------
# Routes — API: calibration library + fitting
# ---------------------------------------------------------------------------
@app.route("/api/library", methods=["GET"])
def api_library():
    curves = CalibrationCurve.query.all()
    return jsonify([c.to_dict() for c in curves])


@app.route("/api/calibration", methods=["POST"])
def api_save_calibration():
    body = request.get_json(force=True)
    analyte = (body.get("analyte") or "custom").strip() or "custom"
    units = body.get("units") or "µM"
    points = body.get("points") or []
    points = [[float(c), float(i)] for c, i in points if c is not None and i is not None]
    if len(points) < 2:
        return jsonify(error="At least 2 calibration standards are required."), 400

    m, b, r2 = fit_linear(points)
    curve = CalibrationCurve.query.filter_by(analyte=analyte).first()
    if curve is None:
        curve = CalibrationCurve(analyte=analyte)
        db.session.add(curve)
    curve.units = units
    curve.points_json = json.dumps(points)
    curve.slope, curve.intercept, curve.r2 = m, b, r2
    db.session.commit()
    return jsonify(curve.to_dict())


# ---------------------------------------------------------------------------
# Routes — API: predict + history
# ---------------------------------------------------------------------------
@app.route("/api/predict", methods=["POST"])
def api_predict():
    body = request.get_json(force=True)
    analyte = body.get("analyte")
    intensity = body.get("intensity")
    if analyte is None or intensity is None:
        return jsonify(error="Analyte and measured intensity are required."), 400

    curve = CalibrationCurve.query.filter_by(analyte=analyte).first()
    if not curve or curve.slope is None:
        return jsonify(error="Calibration curve not found for this analyte."), 404

    concentration = curve.slope * float(intensity) + curve.intercept
    result = Result(
        analyte=analyte, units=curve.units, intensity=intensity,
        concentration=concentration, slope=curve.slope,
        intercept=curve.intercept, r2=curve.r2,
    )
    db.session.add(result)
    db.session.commit()
    return jsonify(result.to_dict())


@app.route("/api/results", methods=["GET"])
def api_results():
    rows = Result.query.order_by(Result.created_at.desc()).limit(20).all()
    return jsonify([r.to_dict() for r in rows])


@app.route("/api/results", methods=["DELETE"])
def api_clear_results():
    Result.query.delete()
    db.session.commit()
    return jsonify(success=True, message="All history records cleared.")


# ---------------------------------------------------------------------------
# Routes — API: email (SMTP dispatch & configuration)
# ---------------------------------------------------------------------------
@app.route("/api/email/status", methods=["GET"])
def api_email_status():
    host = os.environ.get("SMTP_HOST", "")
    port = int(os.environ.get("SMTP_PORT", 587))
    user = os.environ.get("SMTP_USER", "")
    from_email = os.environ.get("FROM_EMAIL", user)
    has_pass = bool(os.environ.get("SMTP_PASS"))
    configured = bool(host and user and has_pass)
    return jsonify(
        configured=configured,
        host=host,
        port=port,
        user=user,
        from_email=from_email,
        has_password=has_pass
    )


@app.route("/api/email/config", methods=["POST"])
def api_email_config():
    data = request.get_json(force=True) or {}
    host = data.get("host", "").strip()
    port = str(data.get("port", 587)).strip()
    user = data.get("user", "").strip()
    password = data.get("password", "").strip()
    from_email = data.get("from_email", "").strip() or user

    # If password was not passed but already exists in environment, retain existing
    if not password and os.environ.get("SMTP_PASS"):
        password = os.environ.get("SMTP_PASS")

    if host:
        os.environ["SMTP_HOST"] = host
    if port:
        os.environ["SMTP_PORT"] = port
    if user:
        os.environ["SMTP_USER"] = user
    if password:
        os.environ["SMTP_PASS"] = password
    if from_email:
        os.environ["FROM_EMAIL"] = from_email

    # Persist into .env file
    env_path = os.path.join(BASE_DIR, ".env")
    lines = []
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                k = line.split("=")[0].strip()
                if k not in ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"]:
                    lines.append(line.rstrip())
    lines.append(f"SMTP_HOST={host}")
    lines.append(f"SMTP_PORT={port}")
    lines.append(f"SMTP_USER={user}")
    lines.append(f"SMTP_PASS={password}")
    lines.append(f"FROM_EMAIL={from_email}")
    with open(env_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    return jsonify(
        success=True,
        configured=bool(host and user and password)
    )


@app.route("/api/email/test", methods=["POST"])
def api_email_test():
    data = request.get_json(force=True) or {}
    host = data.get("host", "").strip() or os.environ.get("SMTP_HOST")
    port = int(data.get("port") or os.environ.get("SMTP_PORT", 587))
    user = data.get("user", "").strip() or os.environ.get("SMTP_USER")
    password = data.get("password", "").strip() or os.environ.get("SMTP_PASS")

    if not all([host, user, password]):
        return jsonify(error="Host, user, and password are required to test connection."), 400

    try:
        with smtplib.SMTP(host, port, timeout=10) as server:
            server.starttls()
            server.login(user, password)
        return jsonify(success=True, message="SMTP connection and authentication verified successfully!")
    except Exception as exc:
        return jsonify(error=f"Connection test failed: {exc}"), 400


@app.route("/api/email", methods=["POST"])
def api_email():
    body = request.get_json(force=True) or {}
    to_addr = (body.get("to") or "").strip()
    result_id = body.get("result_id")

    if not to_addr:
        return jsonify(error="Recipient email address is required."), 400

    result = None
    if result_id:
        result = Result.query.get(result_id)
    if not result:
        # Graceful fallback to latest result if result_id is omitted or stale
        result = Result.query.order_by(Result.created_at.desc()).first()

    if not result:
        return jsonify(error="No measurement result found to send."), 404

    date_str = result.created_at.strftime('%Y-%m-%d %H:%M:%S UTC')
    subject = f"ChemiQuant Result: {result.analyte} ({result.created_at:%Y-%m-%d %H:%M})"
    body_text = (
        f"ChemiQuant Measurement Result — {date_str}\n\n"
        f"Analyte: {result.analyte}\n"
        f"Measured Mean Intensity: {result.intensity:.2f}\n"
        f"Calibration Equation: c = {result.slope:.4f} * I + {result.intercept:.3f}  (R² = {result.r2:.4f})\n"
        f"Estimated Concentration: {result.concentration:.3f} {result.units}\n\n"
        f"Generated by ChemiQuant Chemiluminometer Concentration Analyzer"
    )

    mailto_url = f"mailto:{to_addr}?subject={urllib.parse.quote(subject)}&body={urllib.parse.quote(body_text)}"
    gmail_url = f"https://mail.google.com/mail/?view=cm&fs=1&to={urllib.parse.quote(to_addr)}&su={urllib.parse.quote(subject)}&body={urllib.parse.quote(body_text)}"

    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", 587))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    from_addr = os.environ.get("FROM_EMAIL", user)

    # If SMTP is configured, attempt real delivery
    if host and user and password:
        msg = MIMEText(body_text)
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = to_addr

        try:
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.starttls()
                server.login(user, password)
                server.sendmail(from_addr, [to_addr], msg.as_string())
            return jsonify(
                sent=True,
                mode="smtp",
                to=to_addr,
                message=f"Result successfully sent to {to_addr} via SMTP server."
            )
        except Exception as exc:
            return jsonify(
                sent=False,
                mode="smtp_error",
                error=f"SMTP delivery failed: {exc}",
                to=to_addr,
                subject=subject,
                body=body_text,
                mailto_url=mailto_url,
                gmail_url=gmail_url
            ), 200

    # If SMTP is NOT configured, return fallback URLs with clear info (HTTP 200)
    return jsonify(
        sent=False,
        mode="not_configured",
        message="SMTP credentials are not configured on the server.",
        to=to_addr,
        subject=subject,
        body=body_text,
        mailto_url=mailto_url,
        gmail_url=gmail_url
    ), 200


with app.app_context():
    db.create_all()
    seed_library()

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5001)),
        debug=False
    )
