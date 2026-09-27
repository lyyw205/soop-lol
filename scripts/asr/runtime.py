"""Shared GPU model configuration for installation checks and VOD experiments."""
import torch


def load_engine(engine, model_path, max_tokens=512):
    if engine == "sensevoice":
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        model = AutoModel(model=model_path, device="cuda:0", disable_update=True,
                          trust_remote_code=False, disable_pbar=True)

        def transcribe(waveform):
            result = model.generate(input=waveform, language="ko", use_itn=True,
                                    batch_size=1, disable_pbar=True)
            return rich_transcription_postprocess(result[0]["text"])
    else:
        from qwen_asr import Qwen3ASRModel
        model = Qwen3ASRModel.from_pretrained(
            model_path, dtype=torch.float16, device_map="cuda:0",
            attn_implementation="sdpa", max_inference_batch_size=1,
            max_new_tokens=max_tokens,
        )

        def transcribe(waveform):
            return model.transcribe(audio=(waveform, 16000), language="Korean")[0].text
    return transcribe
