const vision = require('@google-cloud/vision');

const client = new vision.ImageAnnotatorClient();

async function detectLabelsFromBase64(base64Image) {
  if (!base64Image) {
    return [];
  }

  // In case Android sends data with line breaks/spaces
  const cleanedBase64 = base64Image.replace(/\s/g, '');

  const [result] = await client.labelDetection({
    image: {
      content: cleanedBase64
    }
  });

  const labels = result.labelAnnotations || [];

  return labels.map(label => ({
    description: label.description || '',
    score: typeof label.score === 'number' ? label.score : 0
  }));
}

module.exports = {
  detectLabelsFromBase64
};