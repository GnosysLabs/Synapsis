/**
 * Bot Creation Page
 * 
 * Form for creating a new bot.
 * 
 * Requirements: 1.1, 2.1, 3.1
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { UserStorageImageUpload } from '@/components/UserStorageImageUpload';
import { Bot, Sparkles, Rss, Clock, Trash2 } from 'lucide-react';

interface ContentSource {
  type: 'rss' | 'reddit' | 'news_api' | 'brave_news' | 'youtube';
  url: string;
  subreddit?: string;
  apiKey?: string;
  // Brave News config
  braveQuery?: string;
  braveFreshness?: 'pd' | 'pw' | 'pm' | 'py';
  braveCountry?: string;
  // News API config
  newsProvider?: 'newsapi' | 'gnews' | 'newsdata';
  newsQuery?: string;
  newsCategory?: string;
  newsCountry?: string;
  newsLanguage?: string;
  // YouTube config
  youtubeChannelId?: string;
  youtubePlaylistId?: string;
}

export default function NewBotPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'identity' | 'personality' | 'sources' | 'schedule'>('identity');

  const [formData, setFormData] = useState({
    name: '',
    handle: '',
    bio: '',
    avatarUrl: '',
    headerUrl: '',
    systemPrompt: '',
    llmProvider: 'openai',
    llmModel: 'gpt-4',
    llmApiKey: '',
    autonomousMode: false,
    postingFrequency: 'every_4_hours',
    customIntervalMinutes: 240,
  });

  const [sources, setSources] = useState<ContentSource[]>([]);
  const [newSource, setNewSource] = useState<ContentSource>({
    type: 'rss',
    url: '',
    braveQuery: '',
    braveFreshness: 'pw',
    newsProvider: 'newsapi',
    newsQuery: '',
  });

  // Fetch previous bot settings to pre-fill LLM config
  useEffect(() => {
    const fetchPreviousBotSettings = async () => {
      try {
        const res = await fetch('/api/bots');
        if (res.ok) {
          const data = await res.json();
          if (data.bots && data.bots.length > 0) {
            // Get the most recently created bot
            const sortedBots = [...data.bots].sort(
              (a: { createdAt: string }, b: { createdAt: string }) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
            const lastBot = sortedBots[0];

            // Pre-fill LLM settings (but not API key for security)
            setFormData(prev => ({
              ...prev,
              llmProvider: lastBot.llmProvider || 'openai',
              llmModel: lastBot.llmModel || 'gpt-4',
            }));
          }
        }
      } catch (err) {
        // Silently fail - not critical
        console.error('Failed to fetch previous bot settings:', err);
      }
    };

    fetchPreviousBotSettings();
  }, []);

  const handleAddSource = () => {
    // Validate based on type
    if (newSource.type === 'brave_news') {
      if (!newSource.braveQuery || !newSource.apiKey) return;
      // Build URL from config
      const url = new URL('https://api.search.brave.com/res/v1/news/search');
      url.searchParams.set('q', newSource.braveQuery);
      if (newSource.braveFreshness) url.searchParams.set('freshness', newSource.braveFreshness);
      if (newSource.braveCountry) url.searchParams.set('country', newSource.braveCountry);
      setSources([...sources, { ...newSource, url: url.toString() }]);
    } else if (newSource.type === 'news_api') {
      if (!newSource.newsQuery || !newSource.apiKey) return;
      // Build URL from config
      let baseUrl: string;
      const params = new URLSearchParams();
      switch (newSource.newsProvider) {
        case 'gnews':
          baseUrl = 'https://gnews.io/api/v4/search';
          params.set('q', newSource.newsQuery);
          if (newSource.newsCountry) params.set('country', newSource.newsCountry);
          if (newSource.newsLanguage) params.set('lang', newSource.newsLanguage);
          if (newSource.newsCategory) params.set('topic', newSource.newsCategory);
          break;
        case 'newsdata':
          baseUrl = 'https://newsdata.io/api/1/news';
          params.set('q', newSource.newsQuery);
          if (newSource.newsCountry) params.set('country', newSource.newsCountry);
          if (newSource.newsLanguage) params.set('language', newSource.newsLanguage);
          if (newSource.newsCategory) params.set('category', newSource.newsCategory);
          break;
        default:
          baseUrl = 'https://newsapi.org/v2/everything';
          params.set('q', newSource.newsQuery);
          if (newSource.newsLanguage) params.set('language', newSource.newsLanguage);
      }
      setSources([...sources, { ...newSource, url: `${baseUrl}?${params.toString()}` }]);
    } else {
      if (!newSource.url) return;
      setSources([...sources, { ...newSource }]);
    }
    setNewSource({
      type: 'rss',
      url: '',
      braveQuery: '',
      braveFreshness: 'pw',
      newsProvider: 'newsapi',
      newsQuery: '',
    });
  };

  const handleRemoveSource = (index: number) => {
    setSources(sources.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Calculate interval minutes based on frequency
      let intervalMinutes = 240;
      if (formData.postingFrequency === 'every_2_hours') intervalMinutes = 120;
      else if (formData.postingFrequency === 'every_4_hours') intervalMinutes = 240;
      else if (formData.postingFrequency === 'every_6_hours') intervalMinutes = 360;
      else if (formData.postingFrequency === 'daily') intervalMinutes = 1440;

      const response = await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          handle: formData.handle,
          bio: formData.bio,
          avatarUrl: formData.avatarUrl || undefined,
          headerUrl: formData.headerUrl || undefined,
          personality: {
            systemPrompt: formData.systemPrompt,
            temperature: 0.7, // Default value since posts are limited to 400 chars
            maxTokens: 500, // Default value, sufficient for 400 char posts
          },
          llmProvider: formData.llmProvider,
          llmModel: formData.llmModel,
          llmApiKey: formData.llmApiKey,
          autonomousMode: formData.autonomousMode,
          schedule: formData.autonomousMode ? {
            type: 'interval',
            intervalMinutes,
          } : undefined,
        }),
      });

      if (response.ok) {
        const data = await response.json();

        // If sources were added, create them after bot creation
        if (sources.length > 0) {
          for (const source of sources) {
            const sourcePayload: Record<string, unknown> = {
              type: source.type,
              url: source.url,
              subreddit: source.subreddit,
              apiKey: source.apiKey,
            };

            // Add config for brave_news
            if (source.type === 'brave_news' && source.braveQuery) {
              sourcePayload.braveNewsConfig = {
                query: source.braveQuery,
                freshness: source.braveFreshness,
                country: source.braveCountry,
              };
            }

            // Add config for news_api
            if (source.type === 'news_api' && source.newsQuery) {
              sourcePayload.newsApiConfig = {
                provider: source.newsProvider,
                query: source.newsQuery,
                category: source.newsCategory,
                country: source.newsCountry,
                language: source.newsLanguage,
              };
            }

            await fetch(`/api/bots/${data.bot.id}/sources`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(sourcePayload),
            });
          }

          // Trigger the first post to establish a reference point for the schedule
          // This runs in the background - we don't wait for it
          fetch(`/api/bots/${data.bot.id}/post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).catch(() => {
            // Silently fail - the bot will post on the next scheduled run
          });
        }

        router.push(`/bots/${data.bot.id}`);
      } else {
        const data = await response.json();
        console.error('Bot creation failed:', data);
        const errorMsg = data.error || 'Failed to create bot';
        const detailsMsg = data.details ? '\n' + JSON.stringify(data.details, null, 2) : '';
        setError(errorMsg + detailsMsg);
      }
    } catch (err) {
      console.error('Create bot error:', err);
      setError('Failed to create bot');
    } finally {
      setLoading(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 'identity':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                Bot Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input"
                placeholder="My Awesome Bot"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                Handle
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--foreground-tertiary)' }}>@</span>
                <input
                  type="text"
                  value={formData.handle}
                  onChange={(e) => setFormData({ ...formData, handle: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                  className="input"
                  placeholder="mybot"
                  style={{ flex: 1 }}
                />
              </div>
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                Bio
              </label>
              <textarea
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                className="input"
                rows={3}
                placeholder="A brief description of what your bot does..."
                style={{ resize: 'vertical' }}
              />
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                {formData.bio.length}/400 characters
              </p>
            </div>

            <UserStorageImageUpload
              label="Avatar"
              value={formData.avatarUrl}
              onChange={(avatarUrl) => {
                setError('');
                setFormData(prev => ({ ...prev, avatarUrl }));
              }}
              previewWidth={48}
              previewHeight={48}
              previewBorderRadius="50%"
              helperText="Square image recommended (optional)"
              onError={setError}
            />

            <UserStorageImageUpload
              label="Banner"
              value={formData.headerUrl}
              onChange={(headerUrl) => {
                setError('');
                setFormData(prev => ({ ...prev, headerUrl }));
              }}
              previewWidth={120}
              previewHeight={40}
              previewBorderRadius="4px"
              helperText="Wide image recommended, e.g. 1500x500 (optional)"
              onError={setError}
            />
          </div>
        );

      case 'personality':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                System Prompt
              </label>
              <textarea
                value={formData.systemPrompt}
                onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                className="input"
                rows={6}
                placeholder="You are a helpful bot that shares interesting tech news and engages with users about technology..."
                style={{ resize: 'vertical' }}
              />
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                Define your bot's personality, tone, and behavior
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                LLM Provider
              </label>
              <select
                value={formData.llmProvider}
                onChange={(e) => setFormData({ ...formData, llmProvider: e.target.value })}
                className="input"
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                Model
              </label>
              <input
                type="text"
                value={formData.llmModel}
                onChange={(e) => setFormData({ ...formData, llmModel: e.target.value })}
                className="input"
                placeholder="gpt-4"
              />
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                e.g., gpt-4, claude-3-opus, etc.
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                API Key
              </label>
              <input
                type="password"
                value={formData.llmApiKey}
                onChange={(e) => setFormData({ ...formData, llmApiKey: e.target.value })}
                className="input"
                placeholder="sk-..."
              />
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                Your API key is encrypted and stored securely
              </p>
            </div>
          </div>
        );

      case 'sources':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <p style={{ fontSize: '14px', color: 'var(--foreground-secondary)', marginBottom: '16px' }}>
                Add content sources for your bot to pull from (optional)
              </p>

              <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                      Source Type
                    </label>
                    <select
                      value={newSource.type}
                      onChange={(e) => setNewSource({ ...newSource, type: e.target.value as ContentSource['type'] })}
                      className="input"
                    >
                      <option value="rss">RSS Feed</option>
                      <option value="reddit">Reddit</option>
                      <option value="youtube">YouTube Channel/Playlist</option>
                      <option value="brave_news">Brave News Search</option>
                      <option value="news_api">News API (Advanced)</option>
                    </select>
                  </div>

                  {newSource.type === 'rss' && (
                    <div>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                        RSS Feed URL
                      </label>
                      <input
                        type="url"
                        value={newSource.url}
                        onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                        className="input"
                        placeholder="https://example.com/feed.xml"
                      />
                    </div>
                  )}

                  {newSource.type === 'youtube' && (
                    <>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Channel ID or Playlist ID
                        </label>
                        <input
                          type="text"
                          value={newSource.youtubeChannelId || newSource.youtubePlaylistId || ''}
                          onChange={(e) => {
                            const value = e.target.value.trim();
                            // Detect if it's a playlist ID (starts with PL) or channel ID (starts with UC)
                            if (value.startsWith('PL')) {
                              const rssUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${value}`;
                              setNewSource({ ...newSource, youtubePlaylistId: value, youtubeChannelId: '', url: rssUrl });
                            } else {
                              const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${value}`;
                              setNewSource({ ...newSource, youtubeChannelId: value, youtubePlaylistId: '', url: rssUrl });
                            }
                          }}
                          className="input"
                          placeholder="UCxxxx... or PLxxxx..."
                        />
                        <p style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                          Channel IDs start with UC, Playlist IDs start with PL. Find in the YouTube URL.
                        </p>
                      </div>
                    </>
                  )}

                  {newSource.type === 'reddit' && (
                    <>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Subreddit
                        </label>
                        <input
                          type="text"
                          value={newSource.subreddit || ''}
                          onChange={(e) => setNewSource({ ...newSource, subreddit: e.target.value, url: `https://reddit.com/r/${e.target.value}` })}
                          className="input"
                          placeholder="technology"
                        />
                      </div>
                    </>
                  )}

                  {newSource.type === 'brave_news' && (
                    <>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Search Query
                        </label>
                        <input
                          type="text"
                          value={newSource.braveQuery || ''}
                          onChange={(e) => setNewSource({ ...newSource, braveQuery: e.target.value })}
                          className="input"
                          placeholder="AI technology, climate change, etc."
                        />
                        <p style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                          Use quotes for exact phrases, minus to exclude terms
                        </p>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Freshness
                        </label>
                        <select
                          value={newSource.braveFreshness || 'pw'}
                          onChange={(e) => setNewSource({ ...newSource, braveFreshness: e.target.value as ContentSource['braveFreshness'] })}
                          className="input"
                        >
                          <option value="pd">Last 24 hours</option>
                          <option value="pw">Last 7 days</option>
                          <option value="pm">Last 31 days</option>
                          <option value="py">Last year</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Country (optional)
                        </label>
                        <select
                          value={newSource.braveCountry || ''}
                          onChange={(e) => setNewSource({ ...newSource, braveCountry: e.target.value })}
                          className="input"
                        >
                          <option value="">All countries</option>
                          <option value="US">United States</option>
                          <option value="GB">United Kingdom</option>
                          <option value="CA">Canada</option>
                          <option value="AU">Australia</option>
                          <option value="DE">Germany</option>
                          <option value="FR">France</option>
                          <option value="JP">Japan</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Brave API Key
                        </label>
                        <input
                          type="password"
                          value={newSource.apiKey || ''}
                          onChange={(e) => setNewSource({ ...newSource, apiKey: e.target.value })}
                          className="input"
                          placeholder="Your Brave Search API key"
                        />
                        <p style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                          Get your API key at <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>brave.com/search/api</a>
                        </p>
                      </div>
                    </>
                  )}

                  {newSource.type === 'news_api' && (
                    <>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          News Provider
                        </label>
                        <select
                          value={newSource.newsProvider || 'newsapi'}
                          onChange={(e) => setNewSource({ ...newSource, newsProvider: e.target.value as ContentSource['newsProvider'] })}
                          className="input"
                        >
                          <option value="newsapi">NewsAPI.org</option>
                          <option value="gnews">GNews.io</option>
                          <option value="newsdata">NewsData.io</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Search Keywords
                        </label>
                        <input
                          type="text"
                          value={newSource.newsQuery || ''}
                          onChange={(e) => setNewSource({ ...newSource, newsQuery: e.target.value })}
                          className="input"
                          placeholder="technology, AI, startups"
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Category (optional)
                        </label>
                        <select
                          value={newSource.newsCategory || ''}
                          onChange={(e) => setNewSource({ ...newSource, newsCategory: e.target.value })}
                          className="input"
                        >
                          <option value="">All categories</option>
                          <option value="technology">Technology</option>
                          <option value="business">Business</option>
                          <option value="science">Science</option>
                          <option value="health">Health</option>
                          <option value="sports">Sports</option>
                          <option value="entertainment">Entertainment</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          Country (optional)
                        </label>
                        <select
                          value={newSource.newsCountry || ''}
                          onChange={(e) => setNewSource({ ...newSource, newsCountry: e.target.value })}
                          className="input"
                        >
                          <option value="">All countries</option>
                          <option value="us">United States</option>
                          <option value="gb">United Kingdom</option>
                          <option value="ca">Canada</option>
                          <option value="au">Australia</option>
                          <option value="de">Germany</option>
                          <option value="fr">France</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                          API Key
                        </label>
                        <input
                          type="password"
                          value={newSource.apiKey || ''}
                          onChange={(e) => setNewSource({ ...newSource, apiKey: e.target.value })}
                          className="input"
                          placeholder="Your API key"
                        />
                      </div>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={handleAddSource}
                    className="btn btn-primary"
                    disabled={
                      (newSource.type === 'rss' && !newSource.url) ||
                      (newSource.type === 'reddit' && !newSource.subreddit) ||
                      (newSource.type === 'youtube' && !newSource.youtubeChannelId && !newSource.youtubePlaylistId) ||
                      (newSource.type === 'brave_news' && (!newSource.braveQuery || !newSource.apiKey)) ||
                      (newSource.type === 'news_api' && (!newSource.newsQuery || !newSource.apiKey))
                    }
                  >
                    Add Source
                  </button>
                </div>
              </div>

              {sources.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
                    Added Sources ({sources.length})
                  </h3>
                  {sources.map((source, index) => (
                    <div key={index} className="card" style={{ padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 500 }}>
                          {source.type === 'brave_news' ? 'BRAVE NEWS' :
                            source.type === 'youtube' ? 'YOUTUBE' :
                              source.type.toUpperCase()} - {
                            source.type === 'brave_news' ? source.braveQuery :
                              source.type === 'news_api' ? source.newsQuery :
                                source.type === 'youtube' ? (source.youtubeChannelId || source.youtubePlaylistId) :
                                  source.subreddit || new URL(source.url).hostname
                          }
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveSource(index)}
                        className="btn btn-sm"
                        style={{ color: 'var(--error)' }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case 'schedule':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <input
                  type="checkbox"
                  checked={formData.autonomousMode}
                  onChange={(e) => setFormData({ ...formData, autonomousMode: e.target.checked })}
                  style={{ width: '18px', height: '18px' }}
                />
                <span style={{ fontSize: '14px', fontWeight: 500 }}>
                  Enable Autonomous Mode
                </span>
              </label>
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginLeft: '26px' }}>
                Bot will automatically post based on the schedule below
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                Posting Frequency
              </label>
              <select
                value={formData.postingFrequency}
                onChange={(e) => setFormData({ ...formData, postingFrequency: e.target.value })}
                className="input"
                disabled={!formData.autonomousMode}
              >
                <option value="every_2_hours">Every 2 Hours</option>
                <option value="every_4_hours">Every 4 Hours</option>
                <option value="every_6_hours">Every 6 Hours</option>
                <option value="daily">Once Daily</option>
              </select>
            </div>



            <div className="card" style={{ padding: '16px', background: 'var(--background-tertiary)' }}>
              <p style={{ fontSize: '13px', color: 'var(--foreground-secondary)' }}>
                {formData.autonomousMode
                  ? `Your bot will automatically post ${formData.postingFrequency.replace('_', ' ')}.`
                  : 'Autonomous mode is disabled. You can manually trigger posts from the bot dashboard.'}
              </p>
            </div>
          </div>
        );
    }
  };

  const steps = ['identity', 'personality', 'sources', 'schedule'] as const;
  const currentStepIndex = steps.indexOf(step);
  const isLastStep = currentStepIndex === steps.length - 1;

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
        <Link href="/bots" style={{ color: 'var(--foreground)' }}>
          <ArrowLeftIcon />
        </Link>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Bot size={24} />
            Create New Bot
          </h1>
          <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
            Step {currentStepIndex + 1} of {steps.length}: {step.charAt(0).toUpperCase() + step.slice(1)}
          </p>
        </div>
      </header>

      {error && (
        <div className="card" style={{ padding: '16px', marginBottom: '24px', borderColor: 'var(--error)', background: 'rgba(239, 68, 68, 0.1)' }}>
          <p style={{ color: 'var(--error)', fontSize: '14px', whiteSpace: 'pre-wrap', fontFamily: error.includes('{') ? 'monospace' : 'inherit' }}>
            {error}
          </p>
        </div>
      )}

      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {steps.map((s, i) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: '4px',
                borderRadius: 'var(--radius-full)',
                background: i <= currentStepIndex ? 'var(--accent)' : 'var(--border)',
                transition: 'background 0.2s ease',
              }}
            />
          ))}
        </div>
      </div>

      <form onSubmit={handleSubmit} onKeyDown={(e) => {
        // Prevent Enter key from submitting the form except on the last step
        if (e.key === 'Enter' && !isLastStep) {
          e.preventDefault();
        }
      }}>
        <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
          {renderStep()}
        </div>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'space-between' }}>
          <button
            type="button"
            onClick={() => {
              if (currentStepIndex > 0) {
                setStep(steps[currentStepIndex - 1]);
              } else {
                router.back();
              }
            }}
            className="btn"
          >
            {currentStepIndex === 0 ? 'Cancel' : 'Back'}
          </button>

          {!isLastStep ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setStep(steps[currentStepIndex + 1]);
              }}
              className="btn btn-primary"
              disabled={
                (step === 'identity' && (!formData.name || !formData.handle)) ||
                (step === 'personality' && (!formData.systemPrompt || !formData.llmApiKey))
              }
            >
              Next
            </button>
          ) : (
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? 'Creating...' : 'Create Bot'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
