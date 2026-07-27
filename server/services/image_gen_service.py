import io
import os

import torch
from diffusers import AutoPipelineForText2Image


class ImageGenService:
    """Owns the Stable Diffusion pipeline. Job kind (NPC portrait vs event scene), rate limiting,
    and Discord posting are all decided on the Node side (src/images/image_gen_manager.js) - this
    service just turns whatever prompt it's given into one PNG."""

    DEFAULT_MODEL = "stabilityai/sd-turbo"

    def __init__(self, model_id=None, device=None):
        model_id = model_id or os.environ.get("IMAGEGEN_MODEL", self.DEFAULT_MODEL)
        requested_device = device or os.environ.get("IMAGEGEN_DEVICE", "cuda")

        # Unlike TranscriptionEngine (which defaults to "cpu", opt-in to "cuda"), this defaults
        # to "cuda" with automatic fallback: CPU-based diffusion is impractically slow (tens of
        # seconds to minutes per image), so silently defaulting to CPU here would make the
        # feature feel broken rather than just unaccelerated.
        if requested_device == "cuda" and not torch.cuda.is_available():
            print("-> WARNING: IMAGEGEN_DEVICE=cuda requested but no CUDA device found - "
                  "falling back to CPU. Image generation will be much slower.")
            requested_device = "cpu"
        self._device = requested_device

        dtype = torch.float16 if self._device == "cuda" else torch.float32
        self._pipe = AutoPipelineForText2Image.from_pretrained(
            model_id, torch_dtype=dtype, variant="fp16" if self._device == "cuda" else None
        )
        self._pipe.to(self._device)
        if self._device == "cuda":
            self._pipe.enable_attention_slicing()  # headroom on a 6GB card

        print(f"-> Image generation running on: {self._device} (model: {model_id})")

    def generate(self, prompt, negative_prompt=None, width=512, height=512, steps=1, guidance_scale=0.0):
        image = self._pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
        ).images[0]

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()
