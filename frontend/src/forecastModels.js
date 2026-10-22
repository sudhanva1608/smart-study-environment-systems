const MODEL_LABELS = {
  random_forest: 'Random Forest',
  hist_gradient_boosting: 'Histogram Gradient Boosting',
  persistence: 'Recent-reading fallback'
};

export function getForecastModels(methods) {
  if (!methods || typeof methods !== 'object') return [];
  return [...new Set(Object.values(methods).map(method => MODEL_LABELS[method]).filter(Boolean))];
}

export function getForecastMethodDetails(methods) {
  if (!methods || typeof methods !== 'object' || !Object.keys(methods).length) return 'Forecast model selection is not available yet.';
  return Object.entries(methods).map(([sensor, method]) => `${sensor}: ${MODEL_LABELS[method] || 'unknown method'}`).join(' · ');
}
