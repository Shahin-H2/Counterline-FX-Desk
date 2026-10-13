export const CARD_SORTS = ["custom", "name-asc", "name-desc", "price-asc", "price-desc"];

// Orders cards for display and returns their ids. `cards` is [{ id, name, price }] in the custom
// order, which also breaks ties. A card without a price goes last in either price order.
export function sortCards(cards, sort, locale = "en") {
  const list = [...cards];
  if (sort === "name-asc" || sort === "name-desc") {
    const direction = sort === "name-asc" ? 1 : -1;
    list.sort((left, right) => direction * left.name.localeCompare(right.name, locale, { numeric: true, sensitivity: "base" }));
  } else if (sort === "price-asc" || sort === "price-desc") {
    const direction = sort === "price-asc" ? 1 : -1;
    const priced = (card) => Number.isFinite(card.price) && card.price > 0;
    list.sort((left, right) => {
      if (priced(left) !== priced(right)) return priced(left) ? -1 : 1;
      return priced(left) ? direction * (left.price - right.price) : 0;
    });
  }
  return list.map((card) => card.id);
}
