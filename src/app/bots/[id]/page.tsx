/**
 * Bot Detail/Edit Page
 * 
 * View and edit bot configuration, manage sources, view logs.
 * 
 * Requirements: 1.3, 4.6, 8.2
 */

'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/Icons';
import { Bot, Play, Pause, Rss, Activity, Settings, Sparkles, Clock, Trash2, Pencil } from 'lucide-react';
import { useToast } from '@/lib/contexts/ToastContext';

export default function BotDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { showToast } = useToast();
  const botId = params.id as string;
  const [bot, setBot] = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState({
    type: 'rss' as 'rss' | 'reddit' | 'news_api' | 'brave_news',
    url: '',
    subreddit: '',
    apiKey: '',
    // Brave News config
    braveQuery: '',
    braveFreshness: 'pw' as 'pd' | 'pw' | 'pm' | 'py',
    braveCountry: '',
    // News API config
    newsProvider: 'newsapi' as 'newsapi' | 'gnews' | 'newsdata',
    newsQuery: '',
    newsCategory: '',
    newsCountry: '',
    newsLanguage: '',
  });

  useEffect(() => {
    fetchBot();
    fetchSources();
  }, [botId]);

  const fetchBot = async () => {
    try {
      const response = await fetch(`/api/bots/${botId}`);
      if (response.ok) {
        const data = await response.json();
        setBot(data.bot);
      }
    } catch (error) {
      console.error('Failed to fetch bot:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSources = async () => {
    try {
      const response = await fetch(`/api/bots/${botId}/sources`);
      if (response.ok) {
        const data = await response.json();
        setSources(data.sources || []);
      }
    } catch (error) {
      console.error('Failed to fetch sources:', error);
    }
  };

  const handleTriggerPost = async () => {
    setActionLoading(true);
    try {
      const response = await fetch(`/api/bots/${botId}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.ok) {
        showToast('Post triggered successfully!', 'success');
        fetchBot();
      } else {
        const data = await response.json();
        showToast(`Failed to trigger post: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      showToast('Failed to trigger post', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async () => {
    setActionLoading(true);
    try {
      const response = await fetch(`/api/bots/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !bot.isActive }),
      });
      if (response.ok) {
        fetchBot();
      }
    } catch (error) {
      console.error('Failed to toggle bot:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddSource = async () => {
    setActionLoading(true);
    try {
      let url = newSource.url;
      const payload: Record<string, unknown> = {
        type: newSource.type,
        apiKey: newSource.apiKey || undefined,
      };

      // Build URL and config based on type
      if (newSource.type === 'brave_news') {
        if (!newSource.braveQuery || !newSource.apiKey) {
          showToast('Search query and API key are required for Brave News', 'error');
          setActionLoading(false);
          return;
        }
        const braveUrl = new URL('https://api.search.brave.com/res/v1/news/search');
        braveUrl.searchParams.set('q', newSource.braveQuery);
        if (newSource.braveFreshness) braveUrl.searchParams.set('freshness', newSource.braveFreshness);
        if (newSource.braveCountry) braveUrl.searchParams.set('country', newSource.braveCountry);
        url = braveUrl.toString();
        payload.braveNewsConfig = {
          query: newSource.braveQuery,
          freshness: newSource.braveFreshness,
          country: newSource.braveCountry || undefined,
        };
      } else if (newSource.type === 'news_api') {
        if (!newSource.newsQuery || !newSource.apiKey) {
          showToast('Search query and API key are required for News API', 'error');
          setActionLoading(false);
          return;
        }
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
        url = `${baseUrl}?${params.toString()}`;
        payload.newsApiConfig = {
          provider: newSource.newsProvider,
          query: newSource.newsQuery,
          category: newSource.newsCategory || undefined,
          country: newSource.newsCountry || undefined,
          language: newSource.newsLanguage || undefined,
        };
      } else if (newSource.type === 'reddit') {
        payload.subreddit = newSource.subreddit || undefined;
      }

      payload.url = url;

      const response = await fetch(`/api/bots/${botId}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setShowAddSource(false);
        setNewSource({
          type: 'rss',
          url: '',
          subreddit: '',
          apiKey: '',
          braveQuery: '',
          braveFreshness: 'pw',
          braveCountry: '',
          newsProvider: 'newsapi',
          newsQuery: '',
          newsCategory: '',
          newsCountry: '',
          newsLanguage: '',
        });
        fetchSources();
      } else {
        const data = await response.json();
        const details = Array.isArray(data.details) ? ` ${data.details.join(', ')}` : '';
        showToast(`Failed to add source: ${data.error || 'Unknown error'}${details}`, 'error');
      }
    } catch (error) {
      showToast('Failed to add source', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleFetchSource = async (sourceId: string) => {
    setActionLoading(true);
    try {
      const response = await fetch(`/api/bots/${botId}/sources/${sourceId}/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.ok) {
        const data = await response.json();
        showToast(`Fetched ${data.itemsFetched || 0} items successfully!`, 'success');
        fetchSources();
      } else {
        const data = await response.json();
        showToast(`Failed to fetch content: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      showToast('Failed to fetch content', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px 16px 64px' }}>
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--foreground-tertiary)' }}>
          Loading...
        </div>
      </div>
    );
  }

  if (!bot) {
    return (
      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px 16px 64px' }}>
        <div className="card" style={{ padding: '48px 24px', textAlign: 'center' }}>
          <p style={{ color: 'var(--foreground-tertiary)' }}>Bot not found</p>
          <Link href="/bots" className="btn" style={{ marginTop: '16px' }}>
            Back to Bots
          </Link>
        </div>
      </div>
    );
  }

  const scheduleConfig = typeof bot.scheduleConfig === 'string'
    ? JSON.parse(bot.scheduleConfig)
    : bot.scheduleConfig || null;
  const personalityConfig = typeof bot.personalityConfig === 'string'
    ? JSON.parse(bot.personalityConfig)
    : bot.personalityConfig || {};

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px 16px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
        <Link href="/bots" style={{ color: 'var(--foreground)' }}>
          <ArrowLeftIcon />
        </Link>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700 }}>{bot.name}</h1>
            {bot.autonomousMode && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--accent-muted)',
                color: 'var(--accent)',
              }}>
                <Sparkles size={12} />
                Autonomous
              </span>
            )}
          </div>
          <p style={{ fontSize: '14px', color: 'var(--foreground-tertiary)' }}>
            @{bot.handle}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {bot.isSuspended ? (
            <span className="status-pill suspended">Suspended</span>
          ) : bot.isActive ? (
            <span className="status-pill active">Active</span>
          ) : (
            <span className="status-pill">Inactive</span>
          )}
        </div>
      </header>

      {/* Quick Actions */}
      <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Play size={18} />
          Quick Actions
        </h2>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={handleTriggerPost}
            disabled={actionLoading || bot.isSuspended}
            className="btn btn-primary"
          >
            <Play size={16} />
            Trigger Post
          </button>
          <button
            onClick={handleToggleActive}
            disabled={actionLoading || bot.isSuspended}
            className="btn"
          >
            {bot.isActive ? <Pause size={16} /> : <Play size={16} />}
            {bot.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <Link
            href={`/bots/${botId}/edit`}
            className="btn"
          >
            <Pencil size={16} />
            Edit Bot
          </Link>
        </div>
      </div>

      {/* Bot Info */}
      <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={18} />
          Bot Information
        </h2>
        <div style={{ display: 'grid', gap: '12px' }}>
          {bot.bio && (
            <div>
              <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginBottom: '4px' }}>
                Bio
              </div>
              <div style={{ fontSize: '14px', color: 'var(--foreground-secondary)' }}>
                {bot.bio}
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginBottom: '4px' }}>
                Last Post
              </div>
              <div style={{ fontSize: '14px' }}>
                {bot.lastPostAt ? new Date(bot.lastPostAt).toLocaleString() : 'Never'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginBottom: '4px' }}>
                Created
              </div>
              <div style={{ fontSize: '14px' }}>
                {new Date(bot.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', marginBottom: '4px' }}>
                LLM Provider
              </div>
              <div style={{ fontSize: '14px' }}>
                {bot.llmProvider} / {bot.llmModel}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Schedule */}
      {bot.autonomousMode && scheduleConfig && (
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={18} />
            Posting Schedule
          </h2>
          <div style={{ fontSize: '14px', color: 'var(--foreground-secondary)' }}>
            {scheduleConfig.type === 'interval' && scheduleConfig.intervalMinutes
              ? `Posts every ${scheduleConfig.intervalMinutes} minutes`
              : 'Custom schedule configured'}
          </div>
        </div>
      )}

      {/* Personality */}
      <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sparkles size={18} />
          Personality
        </h2>
        <div style={{
          fontSize: '13px',
          color: 'var(--foreground-secondary)',
          background: 'var(--background-tertiary)',
          padding: '12px',
          borderRadius: 'var(--radius-md)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'monospace',
        }}>
          {personalityConfig?.systemPrompt || 'No system prompt configured'}
        </div>
      </div>

      {/* Content Sources */}
      <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Rss size={18} />
            Content Sources ({sources.length})
          </h2>
          <button
            onClick={() => setShowAddSource(!showAddSource)}
            className="btn btn-sm btn-primary"
          >
            {showAddSource ? 'Cancel' : '+ Add Source'}
          </button>
        </div>

        {showAddSource && (
          <div className="card" style={{ padding: '16px', marginBottom: '16px', background: 'var(--background-tertiary)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                  Source Type
                </label>
                <select
                  value={newSource.type}
                  onChange={(e) => setNewSource({ ...newSource, type: e.target.value as typeof newSource.type })}
                  className="input"
                >
                  <option value="rss">RSS Feed</option>
                  <option value="reddit">Reddit</option>
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

              {newSource.type === 'reddit' && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                    Subreddit
                  </label>
                  <input
                    type="text"
                    value={newSource.subreddit}
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
                      value={newSource.braveQuery}
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
                      value={newSource.braveFreshness}
                      onChange={(e) => setNewSource({ ...newSource, braveFreshness: e.target.value as typeof newSource.braveFreshness })}
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
                      value={newSource.braveCountry}
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
                      value={newSource.apiKey}
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
                      value={newSource.newsProvider}
                      onChange={(e) => setNewSource({ ...newSource, newsProvider: e.target.value as typeof newSource.newsProvider })}
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
                      value={newSource.newsQuery}
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
                      value={newSource.newsCategory}
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
                      value={newSource.newsCountry}
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
                      value={newSource.apiKey}
                      onChange={(e) => setNewSource({ ...newSource, apiKey: e.target.value })}
                      className="input"
                      placeholder="Your API key"
                    />
                  </div>
                </>
              )}

              <button
                onClick={handleAddSource}
                disabled={
                  actionLoading ||
                  (newSource.type === 'rss' && !newSource.url) ||
                  (newSource.type === 'reddit' && !newSource.subreddit) ||
                  (newSource.type === 'brave_news' && (!newSource.braveQuery || !newSource.apiKey)) ||
                  (newSource.type === 'news_api' && (!newSource.newsQuery || !newSource.apiKey))
                }
                className="btn btn-primary"
              >
                {actionLoading ? 'Adding...' : 'Add Source'}
              </button>
            </div>
          </div>
        )}

        {sources.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--foreground-tertiary)', textAlign: 'center', padding: '24px 0' }}>
            No content sources configured. Add a source to enable posting.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sources.map((source: any) => {
              let displayName = '';
              try {
                if (source.type === 'brave_news') {
                  const urlObj = new URL(source.url);
                  displayName = urlObj.searchParams.get('q') || 'Brave News';
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
                <div
                  key={source.id}
                  style={{
                    padding: '12px',
                    background: 'var(--background-tertiary)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
                        {source.type === 'brave_news' ? 'BRAVE NEWS' : source.type.toUpperCase()} - {displayName}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--foreground-tertiary)' }}>
                        {source.lastFetchAt ? `Last fetched: ${new Date(source.lastFetchAt).toLocaleString()}` : 'Never fetched'}
                        {source.lastError && <span style={{ color: 'var(--error)' }}> • Error: {source.lastError}</span>}
                      </div>
                    </div>
                    <span className={`status-pill ${source.isActive ? 'active' : ''}`}>
                      {source.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="card" style={{ padding: '20px', borderColor: 'var(--error)' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: 'var(--error)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Trash2 size={18} />
          Danger Zone
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--foreground-secondary)', marginBottom: '12px' }}>
          Deleting a bot is permanent and cannot be undone. All associated data will be removed.
        </p>
        <button
          onClick={() => {
            if (confirm(`Are you sure you want to delete ${bot.name}? This cannot be undone.`)) {
              fetch(`/api/bots/${botId}`, { method: 'DELETE' })
                .then(() => router.push('/bots'))
                .catch(() => showToast('Failed to delete bot', 'error'));
            }
          }}
          className="btn"
          style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
        >
          <Trash2 size={16} />
          Delete Bot
        </button>
      </div>
    </div>
  );
}
