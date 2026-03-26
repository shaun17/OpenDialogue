export async function waitForGateway(baseUrl: string, retries = 60, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
