// AQI-like display estimate only. The breakpoints are anchored to this
// project's relative MQ135 ADC band, not to regulatory pollutant concentration.
export function estimateRelativeAqi(rawAdc) {
  const adc = Number(rawAdc);
  if (!Number.isFinite(adc)) return null;
  const value = Math.max(0, Math.min(4095, adc));
  if (value <= 700) return 0;
  if (value <= 1300) return Math.round(((value - 700) / 600) * 50);
  return Math.round(50 + ((value - 1300) / (4095 - 1300)) * 50);
}
