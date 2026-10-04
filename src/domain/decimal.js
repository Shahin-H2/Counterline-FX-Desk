const DECIMAL_PATTERN = /^(?:\d+)(?:\.(\d+))?$/;

export function toPlainDecimal(value) {
  const input = String(value).trim();
  if (!/[eE]/.test(input)) return input;
  const number = Number(input);
  if (!Number.isFinite(number) || number < 0) return input;
  const [coefficient, exponentText] = input.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function parseDecimal(value, { maxScale = 12, maxDigits = 30 } = {}) {
  const plain = toPlainDecimal(value);
  const match = DECIMAL_PATTERN.exec(plain);
  if (!match || plain.replace(".", "").length > maxDigits) return null;
  const [whole, fraction = ""] = plain.split(".");
  if (fraction.length > maxScale) return null;
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function isPositiveDecimal(value, options) {
  const parsed = parseDecimal(value, options);
  return parsed !== null && parsed.coefficient > 0n;
}

export function multiplyAndRound(amountValue, rateValue, fractionDigits = 2) {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 8) return null;
  const amount = parseDecimal(amountValue);
  const rate = parseDecimal(rateValue);
  if (!amount || !rate) return null;

  const product = amount.coefficient * rate.coefficient;
  const sourceScale = amount.scale + rate.scale;
  const shift = sourceScale - fractionDigits;
  let rounded;
  if (shift <= 0) {
    rounded = product * (10n ** BigInt(-shift));
  } else {
    const divisor = 10n ** BigInt(shift);
    rounded = (product + divisor / 2n) / divisor;
  }

  const digits = rounded.toString().padStart(fractionDigits + 1, "0");
  if (fractionDigits === 0) return digits;
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

export function compareDecimals(leftValue, rightValue) {
  const left = parseDecimal(leftValue);
  const right = parseDecimal(rightValue);
  if (!left || !right) return null;
  const scale = Math.max(left.scale, right.scale);
  const leftValueScaled = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValueScaled = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValueScaled < rightValueScaled ? -1 : leftValueScaled > rightValueScaled ? 1 : 0;
}

export function formatDecimal(value, locale = "en-US", minimumFractionDigits = 2, maximumFractionDigits = 8) {
  const parsed = parseDecimal(value);
  if (!parsed) return "—";
  let raw = parsed.coefficient.toString().padStart(parsed.scale + 1, "0");
  let whole = parsed.scale ? raw.slice(0, -parsed.scale) : raw;
  let fraction = parsed.scale ? raw.slice(-parsed.scale) : "";
  while (fraction.length > minimumFractionDigits && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  if (fraction.length > maximumFractionDigits) fraction = fraction.slice(0, maximumFractionDigits);

  const integerFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimalMark = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  const groupedWhole = integerFormatter.format(BigInt(whole));
  return fraction ? `${groupedWhole}${decimalMark}${fraction}` : groupedWhole;
}

