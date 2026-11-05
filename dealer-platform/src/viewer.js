/** Pointer-driven 360 image viewer. Pass an ordered array of 24–36 frame URLs. */
export function mount360Viewer(root, frameUrls, fallbackUrl, onFrame = () => {}) {
  const image = root.querySelector("[data-spin-image]");
  const count = root.querySelector("[data-spin-count]");
  const message = root.querySelector("[data-spin-message]");
  let frame = 0, lastX = 0, carry = 0, dragging = false;
  const stepPx = 8;
  const validSequence = Array.isArray(frameUrls) && frameUrls.length >= 24 && frameUrls.length <= 36;

  image.src = fallbackUrl;
  if (!validSequence) {
    message.textContent = "360° images are being prepared. Browse the photo gallery below.";
    root.classList.add("spin-unavailable");
    return () => {};
  }

  const loaded = new Array(frameUrls.length);
  let ready = 0;
  const update = (next) => {
    frame = (next + frameUrls.length) % frameUrls.length;
    if (loaded[frame]?.naturalWidth) image.src = loaded[frame].src;
    count.textContent = `${String(frame + 1).padStart(2,"0")} / ${frameUrls.length}`;
    onFrame(frame);
  };
  frameUrls.forEach((url, index) => {
    const photo = new Image();
    loaded[index] = photo;
    photo.decoding = "async";
    photo.onload = () => {
      ready += 1;
      if (index === 0) image.src = photo.src;
      message.textContent = ready === frameUrls.length ? "Drag or swipe to rotate" : `Loading 360° view · ${ready}/${frameUrls.length}`;
    };
    photo.onerror = () => {
      message.textContent = `Frame ${index + 1} could not load. Check the 360 image paths.`;
    };
    photo.src = url;
  });
  const down = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragging = true; lastX = event.clientX; carry = 0;
    root.setPointerCapture(event.pointerId);
  };
  const move = (event) => {
    if (!dragging) return;
    carry += event.clientX - lastX; lastX = event.clientX;
    const steps = Math.trunc(carry / stepPx);
    if (steps) { update(frame - steps); carry -= steps * stepPx; }
  };
  const end = () => { dragging = false; };
  const keydown = (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); update(frame + (event.key === "ArrowLeft" ? -1 : 1));
    }
  };
  const left = root.querySelector("[data-spin-left]");
  const right = root.querySelector("[data-spin-right]");
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  root.addEventListener("lostpointercapture", end);
  root.addEventListener("keydown", keydown);
  left?.addEventListener("click", () => update(frame - 1));
  right?.addEventListener("click", () => update(frame + 1));
  return () => {
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", end);
    root.removeEventListener("pointercancel", end);
    root.removeEventListener("lostpointercapture", end);
    root.removeEventListener("keydown", keydown);
  };
}
