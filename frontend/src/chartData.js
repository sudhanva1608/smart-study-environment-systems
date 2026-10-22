export function prepareChartPoints(data, maxPoints = 500) {
  const valid = (Array.isArray(data) ? data : [])
    .map((point, index) => ({ point, index, value: Number(point?.value) }))
    .filter(({ point, value }) => point?.value !== null && point?.value !== undefined &&
      !(typeof point.value === 'string' && point.value.trim() === '') && Number.isFinite(value))
    .sort((a, b) => {
      const aTime = Date.parse(a.point.timestamp);
      const bTime = Date.parse(b.point.timestamp);
      return Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime - bTime : a.index - b.index;
    });

  if (valid.length <= maxPoints) return valid.map(({ point, value }) => ({ ...point, value }));

  // Keep actual first/minimum/maximum/last readings from each time bucket so
  // large histories render quickly without hiding brief peaks.
  const bucketSize = Math.ceil(valid.length / Math.max(1, Math.floor(maxPoints / 4)));
  const sampled = [];
  for (let start = 0; start < valid.length; start += bucketSize) {
    const bucket = valid.slice(start, start + bucketSize);
    const indexes = new Set([
      0,
      bucket.reduce((best, item, i) => item.value < bucket[best].value ? i : best, 0),
      bucket.reduce((best, item, i) => item.value > bucket[best].value ? i : best, 0),
      bucket.length - 1
    ]);
    [...indexes].sort((a, b) => a - b).forEach(index => {
      const { point, value } = bucket[index];
      sampled.push({ ...point, value });
    });
  }
  return sampled;
}
