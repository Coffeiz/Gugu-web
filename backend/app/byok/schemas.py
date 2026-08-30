"""BYOK API 输入模型。"""
from typing import Literal
from pydantic import BaseModel, Field


class CredentialCreate(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    api_format: str = Field("", max_length=32)
    capability: Literal["llm", "deep_research", "similar_image_search", "speech_to_text"]
    value: str = Field("", max_length=20000)
    base_url: str = Field("", max_length=500)
    model: str = Field("", max_length=200)
    max_tokens: int | None = None
    context_tokens: int | None = None
    thinking: Literal["disabled", "adaptive"] | None = None
    reasoning_effort: Literal["", "low", "medium", "high", "max"] | None = None
    vision: bool = False
    vision_video: bool = False
    vision_audio: bool = False
    vision_detail: Literal["auto", "low", "high", "original"] = "auto"


class CredentialPatch(BaseModel):
    provider: str | None = Field(None, min_length=1, max_length=64)
    value: str | None = Field(None, min_length=1, max_length=20000)
    api_format: str | None = Field(None, max_length=32)
    base_url: str | None = Field(None, max_length=500)
    model: str | None = Field(None, max_length=200)
    max_tokens: int | None = None
    context_tokens: int | None = None
    thinking: Literal["disabled", "adaptive"] | None = None
    reasoning_effort: Literal["", "low", "medium", "high", "max"] | None = None
    vision: bool | None = None
    vision_video: bool | None = None
    vision_audio: bool | None = None
    vision_detail: Literal["auto", "low", "high", "original"] | None = None
    enabled: bool | None = None


class CredentialModelsPreview(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    api_format: str = Field("", max_length=32)
    base_url: str = Field("", max_length=500)
    model: str = Field("", max_length=200)
    api_key: str = Field("", max_length=20000)
    credential_id: int | None = None


class CredentialVisionProbe(CredentialModelsPreview):
    dim: Literal["image", "video", "audio"]


class CredentialTestPreview(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    capability: Literal["deep_research", "similar_image_search"]
    value: str = Field(min_length=1, max_length=20000)
