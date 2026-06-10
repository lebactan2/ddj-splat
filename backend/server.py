import sys
import os

SPLATTER_DIR = r"E:\gaussian real time\splatter-image"
sys.path.append(SPLATTER_DIR)

import torch
import numpy as np
import io
import uuid
import tempfile
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from omegaconf import OmegaConf
from PIL import Image 
from huggingface_hub import hf_hub_download

from utils.app_utils import (
    remove_background, 
    resize_foreground, 
    set_white_background,
    resize_to_128,
    to_tensor,
    get_source_camera_v2w_rmo_and_quats,
    export_to_obj)

from scene.gaussian_predictor import GaussianSplatPredictor
import rembg

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading Splatter Image model... This may take a moment.")

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")
device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
if device.type == "cuda":
    torch.cuda.set_device(0)

model_cfg = OmegaConf.load(os.path.join(SPLATTER_DIR, "gradio_config.yaml"))
model_path = hf_hub_download(repo_id="szymanowiczs/splatter-image-multi-category-v1", filename="model_latest.pth")

model = GaussianSplatPredictor(model_cfg)
ckpt_loaded = torch.load(model_path, map_location=device)
model.load_state_dict(ckpt_loaded["model_state_dict"])
model.to(device)
model.eval()

rembg_session = rembg.new_session()
print("Backend Ready!")

def preprocess_image(input_image: Image.Image, preprocess_background=True, foreground_ratio=0.65):
    if preprocess_background:
        image = input_image.convert("RGB")
        image = remove_background(image, rembg_session)
        image = resize_foreground(image, foreground_ratio)
        image = set_white_background(image)
    else:
        image = input_image
        if image.mode == "RGBA":
            image = set_white_background(image)
    image = resize_to_128(image)
    return image

@torch.no_grad()
def reconstruct_and_export(image: Image.Image):
    image_tensor = to_tensor(image).to(device)
    view_to_world_source, rot_transform_quats = get_source_camera_v2w_rmo_and_quats()
    view_to_world_source = view_to_world_source.to(device)
    rot_transform_quats = rot_transform_quats.to(device)

    reconstruction_unactivated = model(
        image_tensor.unsqueeze(0).unsqueeze(0),
        view_to_world_source,
        rot_transform_quats,
        None,
        activate_output=False)

    ply_out_path = os.path.join(tempfile.gettempdir(), f"splat_{uuid.uuid4().hex}.ply")
    export_to_obj(reconstruction_unactivated, ply_out_path)
    return ply_out_path

@app.post("/process_image")
async def process_image(file: UploadFile = File(...), remove_bg: bool = True):
    print(f"Received image: {file.filename}, remove_bg={remove_bg}")
    image_data = await file.read()
    input_image = Image.open(io.BytesIO(image_data))
    
    print("Preprocessing image...")
    preprocessed = preprocess_image(input_image, preprocess_background=remove_bg)
    
    print("Running 3D reconstruction...")
    ply_out_path = reconstruct_and_export(np.array(preprocessed))
    
    print(f"Done! Sending {ply_out_path}")
    return FileResponse(ply_out_path, media_type="application/octet-stream", filename=f"{file.filename}.ply")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
