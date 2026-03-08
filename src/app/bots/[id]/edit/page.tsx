/**
 * Bot Edit Page
 * 
 * Edit existing bot configuration using the setup wizard.
 * 
 * Requirements: 1.3, 4.6
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { UserStorageImageUpload } from '@/components/UserStorageImageUpload';
import { Bot, Sparkles, Rss, Clock, Trash2 } from 'lucide-react';

interface ContentSource {
  id?: string;
  type: 'rss' | 'reddit' | 'news_api' | 'brave_news' | 'youtube';
  url: string;
  subreddit?: string;
  apiKey?: string;
  fetchIntervalMinutes?: number;
  isActive?: boolean;
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

export default function EditBotPage() {
  const router = useRouter();
  const params = useParams();
  const botId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
    fetchIntervalMinutes: 30,
    braveQuery: '',
    braveFreshness: 'pw',
    newsProvider: 'newsapi',
    newsQuery: '',
  });
  const [sourcesToDelete, setSourcesToDelete] = useState<string[]>([]);

  useEffect(() => {
    fetchBot();
  }, [botId]);

  const fetchBot = async () => {
    try {
      const [botRes, sourcesRes] = await Promise.all([
        fetch(`/api/bots/${botId}`),
        fetch(`/api/bots/${botId}/sources`),
      ]);

      if (!botRes.ok) {
        setError('Bot not found');
        setLoading(false);
        return;
      }

      const botData = await botRes.json();
      const bot = botData.bot;

      const personalityConfig = typeof bot.personalityConfig === 'string'
        ? JSON.parse(bot.personalityConfig)
        : bot.personalityConfig || {};

      const scheduleConfig = typeof bot.scheduleConfig === 'string'
        ? JSON.parse(bot.scheduleConfig)
        : bot.scheduleConfig || {};

      // Determine posting frequency from interval
      let postingFrequency = 'every_4_hours';
      let customIntervalMinutes = 240;
      if (scheduleConfig?.intervalMinutes) {
        const interval = scheduleConfig.intervalMinutes;
        if (interval === 120) postingFrequency = 'every_2_hours';
        else if (interval === 240) postingFrequency = 'every_4_hours';
        else if (interval === 360) postingFrequency = 'every_6_hours';
        else if (interval === 1440) postingFrequency = 'daily';
        else {
          // If it was hourly (60) or custom, default to every_4_hours (240)
          postingFrequency = 'every_4_hours';
          customIntervalMinutes = 240;
        }
      }

      setFormData({
        name: bot.name || '',
        handle: bot.handle || '',
        bio: bot.bio || '',
        avatarUrl: bot.avatarUrl || '',
        headerUrl: bot.headerUrl || '',
        systemPrompt: personalityConfig.systemPrompt || '',
        llmProvider: bot.llmProvider || 'openai',
        llmModel: bot.llmModel || 'gpt-4',
        llmApiKey: '', // Don't pre-fill API key for security
        autonomousMode: bot.autonomousMode || false,
        postingFrequency,
        customIntervalMinutes,
      });

      if (sourcesRes.ok) {
        const sourcesData = await sourcesRes.json();
        setSources(sourcesData.sources || []);
      }
    } catch (err) {
      console.error('Failed to fetch bot:', err);
      setError('Failed to load bot data');
    } finally {
      setLoading(false);
    }
  };

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
      fetchIntervalMinutes: 30,
      braveQuery: '',
      braveFreshness: 'pw',
      newsProvider: 'newsapi',
      newsQuery: '',
    });
  };

  const handleRemoveSource = (index: number) => {
    const source = sources[index];
    if (source.id) {
      setSourcesToDelete([...sourcesToDelete, source.id]);
    }
    setSources(sources.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      // Calculate interval minutes
      let intervalMinutes = 240;
      if (formData.postingFrequency === 'every_2_hours') intervalMinutes = 120;
      else if (formData.postingFrequency === 'every_4_hours') intervalMinutes = 240;
      else if (formData.postingFrequency === 'every_6_hours') intervalMinutes = 360;
      else if (formData.postingFrequency === 'daily') intervalMinutes = 1440;

      // Update bot
      const updatePayload: Record<string, unknown> = {
        name: formData.name,
        bio: formData.bio,
        avatarUrl: formData.avatarUrl || null,
        headerUrl: formData.headerUrl || null,
        personality: {
          systemPrompt: formData.systemPrompt,
          temperature: 0.7,
          maxTokens: 500,
        },
        llmProvider: formData.llmProvider,
        llmModel: formData.llmModel,
        autonomousMode: formData.autonomousMode,
        schedule: formData.autonomousMode ? {
          type: 'interval',
          intervalMinutes,
        } : undefined,
      };

      // Only include API key if user entered a new one
      if (formData.llmApiKey) {
        updatePayload.llmApiKey = formData.llmApiKey;
      }

      const response = await fetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update bot');
      }

      // Delete removed sources
      for (const sourceId of sourcesToDelete) {
        await fetch(`/api/bots/${botId}/sources/${sourceId}`, { method: 'DELETE' });
      }

      // Add new sources (ones without id)
      for (const source of sources) {
        if (!source.id) {
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

          await fetch(`/api/bots/${botId}/sources`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sourcePayload),
          });
        }
      }

      router.push(`/bots/${botId}`);
    } catch (err) {
      console.error('Update bot error:', err);
      setError(err instanceof Error ? err.message : 'Failed to update bot');
    } finally {
      setSaving(false);
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
                required
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
                  className="input"
                  style={{ flex: 1, background: 'var(--background-tertiary)', cursor: 'not-allowed' }}
                  disabled
                />
              </div>
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                Handle cannot be changed after creation
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
                placeholder="You are a helpful bot that shares interesting tech news..."
                style={{ resize: 'vertical' }}
                required
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
                required
              />
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
                placeholder="Leave blank to keep existing key"
              />
              <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginTop: '6px' }}>
                Only enter a new key if you want to change it
              </p>
            </div>
          </div>
        );

      case 'sources':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <p style={{ fontSize: '14px', color: 'var(--foreground-secondary)', marginBottom: '16px' }}>
                Manage content sources for your bot
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
                    Sources ({sources.length})
                  </h3>
                  {sources.map((source, index) => {
                    let displayName = '';
                    try {
                      if (source.type === 'brave_news') {
                        // Try to extract query from URL or use stored config
                        const urlObj = new URL(source.url);
                        displayName = urlObj.searchParams.get('q') || 'Brave News';
                      } else if (source.type === 'youtube') {
                        // Extract channel/playlist ID from YouTube RSS URL
                        const urlObj = new URL(source.url);
                        displayName = urlObj.searchParams.get('channel_id') || urlObj.searchParams.get('playlist_id') || 'YouTube';
                      } else if (source.subreddit) {
                        displayName = source.subreddit;
                      } else if (source.url) {
                        displayName = new URL(source.url).hostname;
                      } else {
                        displayName = 'Unknown';
                      }
                    } catch {
                      displayName = source.url || 'Unknown';
                    }

                    return (
                      <div key={source.id || index} className="card" style={{ padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 500 }}>
                            {source.type === 'brave_news' ? 'BRAVE NEWS' :
                              source.type === 'youtube' ? 'YOUTUBE' :
                                source.type.toUpperCase()} - {displayName}
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)', marginTop: '4px' }}>
                            {source.id ? 'Existing source' : 'New source (will be added)'}
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
                    );
                  })}
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

  if (loading) {
    return (
      <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px 16px 64px' }}>
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--foreground-tertiary)' }}>
          Loading...
        </div>
      </div>
    );
  }

  const steps = ['identity', 'personality', 'sources', 'schedule'] as const;
  const currentStepIndex = steps.indexOf(step);
  const isLastStep = currentStepIndex === steps.length - 1;

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '24px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
        <Link href={`/settings/bots/${botId}`} style={{ color: 'var(--foreground)' }}>
          <ArrowLeftIcon />
        </Link>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Bot size={24} />
            Edit Bot
          </h1>
          <p style={{ color: 'var(--foreground-tertiary)', fontSize: '14px' }}>
            Step {currentStepIndex + 1} of {steps.length}: {step.charAt(0).toUpperCase() + step.slice(1)}
          </p>
        </div>
      </header>

      {error && (
        <div className="card" style={{ padding: '16px', marginBottom: '24px', borderColor: 'var(--error)', background: 'rgba(239, 68, 68, 0.1)' }}>
          <p style={{ color: 'var(--error)', fontSize: '14px' }}>{error}</p>
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

      <form onSubmit={handleSubmit} onKeyDown={(e) => { if (e.key === 'Enter' && !isLastStep) e.preventDefault(); }}>
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
                router.push(`/settings/bots/${botId}`);
              }
            }}
            className="btn"
          >
            {currentStepIndex === 0 ? 'Cancel' : 'Back'}
          </button>

          {!isLastStep && (
            <button
              key="next-button"
              type="button"
              onClick={() => setStep(steps[currentStepIndex + 1])}
              className="btn btn-primary"
              disabled={step === 'identity' && !formData.name}
            >
              Next
            </button>
          )}
          {isLastStep && (
            <button
              key="submit-button"
              type="submit"
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
