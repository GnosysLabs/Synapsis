import { describe, expect, it } from 'vitest';
import { renderStuffboxPopupResponse } from './popup-response';

describe('renderStuffboxPopupResponse', () => {
  it('notifies the main tab without navigating the popup into Synapsis', () => {
    const html = renderStuffboxPopupResponse('https://synapsis.example', true, 'Stuffbox connected.', 'attempt-123');

    expect(html).toContain("new BroadcastChannel('synapsis:stuffbox')");
    expect(html).toContain("localStorage.setItem('synapsis:stuffbox:result'");
    expect(html).toContain('attempt-123');
    expect(html).toContain('window.setTimeout(() => window.close(), 250)');
    expect(html).not.toContain('window.location.replace');
  });
});
