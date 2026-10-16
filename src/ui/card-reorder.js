// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Drag-to-reorder for a grid of cards, in the manner of iOS widgets: the picked-up card lifts and
// follows the pointer while its neighbours slide out of the way.
//
// It is built on Pointer Events rather than HTML5 drag and drop. Native dragging hands the cursor
// and a ghost image to the browser, so the card itself cannot follow the pointer or show a
// grabbing cursor, and it does not work on touch screens.
//
// The look of each state lives in styles.css. This module only toggles classes and writes the
// card's offset into --drag-x and --drag-y:
//   card  .is-dragging   under the pointer        card  .is-settling  easing into its slot
//   card  .is-lifted     picked up by keyboard    grid  .is-reordering, body .is-card-dragging

const DRAG_THRESHOLD = 6; // px a mouse or pen travels before a press becomes a drag
const TOUCH_HOLD_MS = 250; // a finger must rest this long first, so that a swipe still scrolls
const TOUCH_SLOP = 8;
const SETTLE_MS = 200; // the drop transition in styles.css
const EDGE_ZONE = 72; // px from the top or bottom of the viewport where a drag scrolls the page
const EDGE_SPEED = 16; // px per frame at the very edge
const INTERACTIVE = "a, button, input, select, textarea, label, [contenteditable], [data-no-drag]";

export function moveItem(order, from, to) {
  const next = [...order];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// Index of the box under a point, or -1. `spread` widens every box so the gaps between cards count.
export function slotAt(boxes, point, spread = 0) {
  return boxes.findIndex((box) => (
    point.x >= box.left - spread && point.x <= box.left + box.width + spread &&
    point.y >= box.top - spread && point.y <= box.top + box.height + spread
  ));
}

// Applies a DOM change and lets every element it displaces slide to its new place: note where
// each one is, make the change, hold each visually where it was, then release it so the element's
// own `transition: transform` rule in styles.css carries it over.
export function slide(elements, change) {
  const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  change();
  const moved = elements.filter((element) => element.isConnected);
  for (const element of moved) {
    element.style.transition = "none";
    element.style.transform = "none";
  }
  const after = new Map(moved.map((element) => [element, element.getBoundingClientRect()]));
  for (const element of moved) {
    const deltaX = before.get(element).left - after.get(element).left;
    const deltaY = before.get(element).top - after.get(element).top;
    element.style.transform = Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 ? "" : `translate(${deltaX}px, ${deltaY}px)`;
  }
  void document.body.offsetWidth; // commit the held positions before the transition is switched back on
  for (const element of moved) {
    element.style.transition = "";
    element.style.transform = "";
  }
}

export function createCardReorder(grid, {
  itemSelector = "[data-history-card-id]",
  getId = (card) => card.dataset.historyCardId,
  getName = (card) => card.dataset.cardName ?? getId(card),
  onPickUp = () => {}, // (cards) as a card is lifted, before anything moves
  onReorder = () => {}, // (ids) once a move is committed
  onIdle = () => {}, // when a drag or keyboard move has completely finished
  announce = () => {},
} = {}) {
  let state = "idle"; // idle | pressed | dragging | settling | lifted
  let card = null;
  let pointerId = null;
  let pointerType = "mouse";
  let press = { x: 0, y: 0 };
  let pointer = { x: 0, y: 0 };
  let grab = { x: 0, y: 0 }; // where inside the card it was picked up
  let startOrder = [];
  let guard = null; // the card last swapped with, ignored until the pointer has left it
  let gap = 0;
  let holdTimer = 0;
  let frame = 0;
  let moving = false; // true while this module moves the focused card in the DOM

  const cards = () => [...grid.querySelectorAll(`:scope > ${itemSelector}`)];
  const currentOrder = () => cards().map(getId);
  const sameOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

  // Where a card sits in the layout, in viewport coordinates, whatever transform is on it.
  // The grid is positioned in styles.css, so offsetLeft and offsetTop are measured from it.
  function layoutBox(element, gridRect = grid.getBoundingClientRect()) {
    return {
      left: gridRect.left + grid.clientLeft + element.offsetLeft,
      top: gridRect.top + grid.clientTop + element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  }

  // Applies a DOM change; every card it displaces slides to its new place. The card being
  // dragged is left out, because it follows the pointer instead.
  function reflow(change, includeActiveCard = false) {
    slide(cards().filter((element) => includeActiveCard || element !== card), change);
  }

  function placeAt(items, from, to) {
    const target = items[to];
    grid.insertBefore(card, to > from ? target.nextSibling : target);
  }

  function restoreStartOrder() {
    const byId = new Map(cards().map((element) => [getId(element), element]));
    for (const id of startOrder) if (byId.has(id)) grid.append(byId.get(id));
  }

  // Keeps the dragged card under the pointer, measured from the slot it currently occupies.
  function follow() {
    const box = layoutBox(card);
    card.style.setProperty("--drag-x", `${pointer.x - grab.x - box.left}px`);
    card.style.setProperty("--drag-y", `${pointer.y - grab.y - box.top}px`);
  }

  function update() {
    const gridRect = grid.getBoundingClientRect();
    const items = cards();
    const boxes = items.map((element) => layoutBox(element, gridRect));
    const guardIndex = items.indexOf(guard);
    if (guard && (guardIndex === -1 || slotAt([boxes[guardIndex]], pointer, gap / 2) === -1)) guard = null;
    const from = items.indexOf(card);
    const to = slotAt(boxes, pointer, gap / 2);
    if (to !== -1 && to !== from && items[to] !== guard) {
      guard = items[to];
      reflow(() => placeAt(items, from, to));
    }
    follow();
  }

  // One loop per drag: scrolls the page near its edges and keeps the slot under the pointer current.
  function tick() {
    if (state !== "dragging") return;
    const above = EDGE_ZONE - pointer.y;
    const below = pointer.y - (window.innerHeight - EDGE_ZONE);
    const push = above > 0 ? -Math.min(1, above / EDGE_ZONE) : below > 0 ? Math.min(1, below / EDGE_ZONE) : 0;
    if (push) window.scrollBy({ top: push * EDGE_SPEED, behavior: "instant" });
    update();
    frame = requestAnimationFrame(tick);
  }

  function beginDrag() {
    if (state !== "pressed") return;
    state = "dragging";
    startOrder = currentOrder();
    guard = null;
    gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    // The grid captures the pointer because, unlike the card, it is never moved in the DOM.
    try {
      grid.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone; pointerup or pointercancel will follow.
    }
    onPickUp(cards());
    grid.classList.add("is-reordering");
    document.body.classList.add("is-card-dragging");
    card.classList.add("is-dragging");
    follow();
    frame = requestAnimationFrame(tick);
  }

  function listen(active) {
    const method = active ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", onPointerMove, true);
    window[method]("pointerup", onPointerUp, true);
    window[method]("pointercancel", onPointerCancel, true);
    window[method]("keydown", onEscape, true);
    window[method]("blur", cancel);
  }

  function reset() {
    window.clearTimeout(holdTimer);
    listen(false);
    card = null;
    pointerId = null;
    state = "idle";
  }

  function finish() {
    card.classList.remove("is-settling");
    grid.classList.remove("is-reordering");
    card = null;
    pointerId = null;
    guard = null;
    state = "idle";
    onIdle();
  }

  function drop(commit) {
    cancelAnimationFrame(frame);
    if (commit) {
      update();
    } else {
      reflow(restoreStartOrder);
      follow();
    }
    const finalOrder = currentOrder();
    state = "settling";
    listen(false);
    // Releasing the card must not also click whatever is inside it.
    const swallowClick = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
    try {
      grid.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
    void card.offsetWidth; // commit the release position, then let the card ease into its slot
    card.classList.add("is-settling");
    card.classList.remove("is-dragging");
    card.style.removeProperty("--drag-x");
    card.style.removeProperty("--drag-y");
    document.body.classList.remove("is-card-dragging");
    if (commit && !sameOrder(finalOrder, startOrder)) onReorder(finalOrder);
    window.setTimeout(finish, SETTLE_MS + 60);
  }

  function cancel() {
    if (state === "pressed") reset();
    else if (state === "dragging") drop(false);
  }

  function onPointerDown(event) {
    if (state !== "idle" || event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    const target = event.target.closest?.(itemSelector);
    if (!target || target.parentElement !== grid || event.target.closest(INTERACTIVE)) return;
    card = target;
    pointerId = event.pointerId;
    pointerType = event.pointerType;
    press = { x: event.clientX, y: event.clientY };
    pointer = press;
    const box = layoutBox(card);
    grab = { x: press.x - box.left, y: press.y - box.top };
    state = "pressed";
    listen(true);
    if (pointerType === "touch") holdTimer = window.setTimeout(beginDrag, TOUCH_HOLD_MS);
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (state !== "pressed") return;
    const travelled = Math.hypot(pointer.x - press.x, pointer.y - press.y);
    if (pointerType === "touch") {
      if (travelled > TOUCH_SLOP) reset(); // a swipe: the page scrolls as usual
    } else if (travelled > DRAG_THRESHOLD) {
      beginDrag();
    }
  }

  function onPointerUp(event) {
    if (event.pointerId !== pointerId) return;
    if (state === "pressed") reset();
    else if (state === "dragging") drop(true);
  }

  function onPointerCancel(event) {
    if (event.pointerId === pointerId) cancel();
  }

  function onEscape(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  }

  // Keyboard: Space or Enter picks a card up, the arrow keys move it, Space or Enter drops it.
  function lift(target) {
    card = target;
    startOrder = currentOrder();
    state = "lifted";
    onPickUp(cards());
    grid.classList.add("is-reordering");
    card.classList.add("is-lifted");
    announce(`${getName(card)} picked up. Use the arrow keys to move it, Space to drop it, Escape to cancel.`);
  }

  function moveInDom(change) {
    moving = true;
    reflow(change, true);
    card.focus({ preventScroll: true });
    moving = false;
    card.scrollIntoView({ block: "nearest" });
  }

  function step(key) {
    const items = cards();
    const from = items.indexOf(card);
    const columns = items.filter((element) => element.offsetTop === items[0].offsetTop).length || 1;
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[key];
    const to = Math.max(0, Math.min(items.length - 1, from + offset));
    if (to === from) return;
    moveInDom(() => placeAt(items, from, to));
    announce(`${getName(card)} moved to position ${to + 1} of ${items.length}.`);
  }

  function release(commit) {
    if (!commit) moveInDom(restoreStartOrder);
    const finalOrder = currentOrder();
    const name = getName(card);
    card.classList.remove("is-lifted");
    grid.classList.remove("is-reordering");
    card = null;
    state = "idle";
    if (commit && !sameOrder(finalOrder, startOrder)) onReorder(finalOrder);
    else announce(commit ? `${name} dropped where it started.` : `Move cancelled. ${name} is back where it started.`);
    onIdle();
  }

  function onKeyDown(event) {
    if (state === "lifted") {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        step(event.key);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        release(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        release(false);
      }
      return;
    }
    const target = event.target;
    if (state !== "idle" || (event.key !== " " && event.key !== "Enter")) return;
    if (!target.matches?.(itemSelector) || target.parentElement !== grid) return;
    event.preventDefault();
    lift(target);
  }

  grid.addEventListener("pointerdown", onPointerDown);
  grid.addEventListener("keydown", onKeyDown);
  // Leaving the card with Tab or a click drops it where it is.
  grid.addEventListener("focusout", () => {
    if (state === "lifted" && !moving) release(true);
  });
  grid.addEventListener("lostpointercapture", (event) => {
    if (state === "dragging" && event.pointerId === pointerId) drop(false);
  });
  // Once a card is lifted on a touch screen, the finger moves the card and not the page.
  grid.addEventListener("touchmove", (event) => {
    if (state === "dragging" && event.cancelable) event.preventDefault();
  }, { passive: false });
  grid.addEventListener("contextmenu", (event) => {
    if (state !== "idle") event.preventDefault();
  });

  return {
    // True while a card is picked up or settling; the owner should not re-render the grid then.
    isActive: () => state === "dragging" || state === "settling" || state === "lifted",
  };
}
