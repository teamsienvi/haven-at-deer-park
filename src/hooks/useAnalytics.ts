import { useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { isTrackingExcluded } from '@/lib/trackingExclusion';

// ============== VISITOR & SESSION MANAGEMENT ==============

const VISITOR_ID_KEY = 'haven_visitor_id';
const SESSION_ID_KEY = 'haven_session_id';
const SESSION_START_KEY = 'haven_session_start';
const ATTRIBUTION_KEY = 'haven_session_attribution';
const INTERNAL_FLAG_KEY = 'haven_internal_flag';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Initialize visitor ID immediately on module load
const initVisitorId = (): string => {
  if (typeof window === 'undefined') return '';
  let visitorId = localStorage.getItem(VISITOR_ID_KEY);
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    localStorage.setItem(VISITOR_ID_KEY, visitorId);
  }
  return visitorId;
};

// Initialize session ID immediately on module load
const initSessionId = (): string => {
  if (typeof window === 'undefined') return '';
  const storedSessionId = sessionStorage.getItem(SESSION_ID_KEY);
  const sessionStart = sessionStorage.getItem(SESSION_START_KEY);
  const now = Date.now();
  
  // If session exists and hasn't timed out, reuse it
  if (storedSessionId && sessionStart) {
    const sessionAge = now - parseInt(sessionStart, 10);
    if (sessionAge < SESSION_TIMEOUT_MS) {
      return storedSessionId;
    }
  }
  
  // Create new session
  const newSessionId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_ID_KEY, newSessionId);
  sessionStorage.setItem(SESSION_START_KEY, now.toString());
  // Clear attribution for new session
  sessionStorage.removeItem(ATTRIBUTION_KEY);
  return newSessionId;
};

// Initialize immediately so click tracking works
const CURRENT_VISITOR_ID = initVisitorId();
const CURRENT_SESSION_ID = initSessionId();

// Get current session ID (for external use)
export const getSessionId = (): string => {
  return sessionStorage.getItem(SESSION_ID_KEY) || CURRENT_SESSION_ID;
};

// Get current visitor ID (for external use)
export const getVisitorId = (): string => {
  return localStorage.getItem(VISITOR_ID_KEY) || CURRENT_VISITOR_ID;
};

// Refresh session timestamp on activity
const refreshSessionActivity = () => {
  sessionStorage.setItem(SESSION_START_KEY, Date.now().toString());
};

// ============== DEVICE & BROWSER DETECTION ==============

export const getDeviceType = (): string => {
  if (typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent.toLowerCase();
  if (/tablet|ipad|playbook|silk/i.test(ua) || 
      (window.innerWidth >= 768 && window.innerWidth < 1024 && 'ontouchstart' in window)) {
    return 'tablet';
  }
  if (/mobile|iphone|ipod|android.*mobile|blackberry|opera mini|iemobile|windows phone/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
};

const getBrowser = (): string => {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('SamsungBrowser')) return 'Samsung Browser';
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return 'Unknown';
};

const getOS = (): string => {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Unknown';
};

// ============== BOT DETECTION ==============

const BOT_PATTERNS = [
  'bot', 'crawl', 'spider', 'slurp', 'googlebot', 'bingbot', 'yandex',
  'baiduspider', 'facebookexternalhit', 'twitterbot', 'rogerbot', 'linkedinbot',
  'embedly', 'quora link preview', 'showyoubot', 'outbrain', 'pinterest',
  'applebot', 'semrush', 'ahrefsbot', 'mj12bot', 'dotbot'
];

const isBot = (): boolean => {
  const ua = navigator.userAgent.toLowerCase();
  return BOT_PATTERNS.some(pattern => ua.includes(pattern));
};

// ============== UTM & ATTRIBUTION ==============

interface Attribution {
  landing_page: string;
  initial_referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
}

const getAttribution = (): Attribution | null => {
  const stored = sessionStorage.getItem(ATTRIBUTION_KEY);
  if (stored) {
    return JSON.parse(stored);
  }
  return null;
};

const captureAttribution = (): Attribution => {
  // Check if already captured for this session
  const existing = getAttribution();
  if (existing) return existing;
  
  const params = new URLSearchParams(window.location.search);
  const attribution: Attribution = {
    landing_page: window.location.pathname,
    initial_referrer: document.referrer || null,
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    utm_term: params.get('utm_term'),
    utm_content: params.get('utm_content'),
  };
  
  sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
  return attribution;
};

// ============== INTERNAL TRAFFIC DETECTION ==============

const checkInternalTraffic = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('internal') === '1') {
    localStorage.setItem(INTERNAL_FLAG_KEY, 'true');
    return true;
  }
  return localStorage.getItem(INTERNAL_FLAG_KEY) === 'true';
};

// ============== DEDUPLICATION ==============

const PAGEVIEW_THROTTLE_MS = 2000; // 2 seconds dedupe window
const lastPageviewTime: Record<string, number> = {};
const sessionCreated: Record<string, boolean> = {};

const shouldTrackPageview = (path: string): boolean => {
  const now = Date.now();
  const lastTime = lastPageviewTime[path];
  
  if (lastTime && (now - lastTime) < PAGEVIEW_THROTTLE_MS) {
    console.log('[Analytics] Duplicate pageview blocked:', path);
    return false;
  }
  
  lastPageviewTime[path] = now;
  return true;
};

// ============== MAIN HOOK ==============

export function useAnalytics() {
  const location = useLocation();
  const sessionInitialized = useRef(false);
  const sessionReady = useRef(false);
  const pageViewId = useRef<string | null>(null);
  const pageLoadTime = useRef<number>(Date.now());
  const maxScrollDepth = useRef(0);
  const pageCount = useRef(0);
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null);
  const lastTrackedPath = useRef<string | null>(null);
  const pendingPageViews = useRef<string[]>([]);

  const visitorId = getVisitorId();
  const sessionId = getSessionId();
  // Bots and internal team traffic are never recorded
  const isUntrackedVisitor = isBot() || isTrackingExcluded();
  const isInternalVisitor = checkInternalTraffic();

  // Initialize session (once per session) - must complete before pageviews
  const initSession = useCallback(async () => {
    if (sessionInitialized.current) {
      return sessionReady.current;
    }
    if (sessionCreated[sessionId]) {
      sessionReady.current = true;
      return true;
    }
    if (isUntrackedVisitor) {
      console.log('[Analytics] Bot detected, skipping session init');
      return false;
    }
    
    sessionInitialized.current = true;

    const attribution = captureAttribution();
    
    // Check if visitor is repeat
    const isRepeat = localStorage.getItem(VISITOR_ID_KEY) === visitorId;

    try {
      const { error } = await supabase.from('analytics_sessions').insert({
        visitor_id: visitorId,
        session_id: sessionId,
        device_type: getDeviceType(),
        browser: getBrowser(),
        os: getOS(),
        screen_width: window.screen.width,
        screen_height: window.screen.height,
        referrer: attribution.initial_referrer,
        entry_page: attribution.landing_page || window.location.pathname,
        utm_source: attribution.utm_source,
        utm_medium: attribution.utm_medium,
        utm_campaign: attribution.utm_campaign,
        utm_term: attribution.utm_term,
        utm_content: attribution.utm_content,
        is_bounce: true,
        is_repeat_visitor: isRepeat,
      });

      if (error) {
        console.error('[Analytics] Session insert error:', error);
        return false;
      }

      sessionCreated[sessionId] = true;
      sessionReady.current = true;

      // Track traffic source
      const source = attribution.utm_source || 
        (attribution.initial_referrer ? (() => { try { return new URL(attribution.initial_referrer).hostname; } catch { return 'direct'; } })() : 'direct');
      
      await supabase.from('analytics_traffic_sources').insert({
        session_id: sessionId,
        source,
        medium: attribution.utm_medium,
        campaign: attribution.utm_campaign,
        referrer_url: attribution.initial_referrer,
        referrer_domain: attribution.initial_referrer 
          ? (() => { try { return new URL(attribution.initial_referrer).hostname; } catch { return null; } })() 
          : null,
      });

      console.log('[Analytics] Session initialized:', sessionId, { 
        isBot: isUntrackedVisitor, 
        isInternal: isInternalVisitor,
        source 
      });

      // Process any pending pageviews
      for (const pendingPath of pendingPageViews.current) {
        await trackPageViewInternal(pendingPath);
      }
      pendingPageViews.current = [];

      return true;
    } catch (error) {
      console.error('[Analytics] Failed to init session:', error);
      return false;
    }
  }, [visitorId, sessionId, isUntrackedVisitor, isInternalVisitor]);

  // Internal pageview tracking (assumes session is ready)
  const trackPageViewInternal = async (path: string) => {
    try {
      let loadTime = 0;
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries.length > 0) {
        const navTiming = navEntries[0] as PerformanceNavigationTiming;
        loadTime = Math.round(navTiming.domContentLoadedEventEnd - navTiming.startTime);
      }

      console.log('[Analytics] Inserting pageview:', { path, sessionId, visitorId });

      const { data, error } = await supabase
        .from('analytics_pageviews')
        .insert({
          session_id: sessionId,
          visitor_id: visitorId,
          path,
          title: document.title,
          load_time_ms: loadTime > 0 ? loadTime : null,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[Analytics] Pageview insert error:', error);
      } else if (data) {
        pageViewId.current = data.id;
        console.log('[Analytics] Pageview tracked:', path, data.id);
      }
    } catch (error) {
      console.error('[Analytics] Failed to track pageview:', error);
    }
  };

  // Track page view with deduplication - waits for session to be ready
  const trackPageView = useCallback(async () => {
    if (isUntrackedVisitor) {
      console.log('[Analytics] Bot detected, skipping pageview');
      return;
    }
    
    const path = location.pathname;
    
    // Prevent duplicate pageview for same path on same render
    if (lastTrackedPath.current === path) {
      console.log('[Analytics] Same path, skipping:', path);
      return;
    }
    
    if (!shouldTrackPageview(path)) return;
    
    lastTrackedPath.current = path;
    pageLoadTime.current = Date.now();
    maxScrollDepth.current = 0;
    pageCount.current += 1;

    // Refresh session activity
    refreshSessionActivity();

    // If session isn't ready yet, queue the pageview and let initSession handle it
    if (!sessionReady.current) {
      console.log('[Analytics] Session not ready, queuing pageview:', path);
      pendingPageViews.current.push(path);
      return;
    }

    // Mark as not bounce after first page
    if (pageCount.current > 1) {
      supabase
        .from('analytics_sessions')
        .update({ is_bounce: false })
        .eq('session_id', sessionId)
        .then(({ error }) => {
          if (error) console.error('[Analytics] Failed to update bounce status:', error);
        });
    }

    await trackPageViewInternal(path);
  }, [location.pathname, sessionId, visitorId, isUntrackedVisitor]);

  // Update page view on leave
  const updatePageView = useCallback(async () => {
    if (!pageViewId.current || isUntrackedVisitor) return;

    const timeOnPage = Date.now() - pageLoadTime.current;

    try {
      const { error } = await supabase
        .from('analytics_pageviews')
        .update({
          time_on_page_ms: timeOnPage,
          scroll_depth: maxScrollDepth.current,
        })
        .eq('id', pageViewId.current);
      
      if (error) {
        console.error('[Analytics] Failed to update pageview:', error);
      }
    } catch (error) {
      console.error('[Analytics] Failed to update pageview:', error);
    }
  }, [isUntrackedVisitor]);

  // Update session heartbeat and exit page
  const updateSessionHeartbeat = useCallback(async () => {
    if (isUntrackedVisitor) return;
    
    try {
      await supabase
        .from('analytics_sessions')
        .update({ 
          ended_at: new Date().toISOString(),
          exit_page: location.pathname,
        })
        .eq('session_id', sessionId);
    } catch (error) {
      console.error('[Analytics] Failed to update session heartbeat:', error);
    }
  }, [sessionId, location.pathname, isUntrackedVisitor]);

  // Scroll tracking
  useEffect(() => {
    const handleScroll = () => {
      const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollHeight > 0) {
        const scrollPercent = Math.round((window.scrollY / scrollHeight) * 100);
        maxScrollDepth.current = Math.max(maxScrollDepth.current, scrollPercent);
      }
      // Refresh session activity on scroll
      refreshSessionActivity();
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Initialize session on mount and then track first pageview
  useEffect(() => {
    const init = async () => {
      const sessionReady = await initSession();
      if (sessionReady) {
        // Track initial pageview after session is ready
        trackPageView();
      }
    };
    
    init();

    // Start heartbeat every 30 seconds
    heartbeatInterval.current = setInterval(updateSessionHeartbeat, 30000);

    return () => {
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
      }
      updatePageView();
      updateSessionHeartbeat();
    };
  }, [initSession, updateSessionHeartbeat, updatePageView, trackPageView]);

  // Track page views on route change (after initial load)
  useEffect(() => {
    // Skip initial mount - handled by initSession effect
    if (!sessionReady.current) return;
    
    // Update previous page view before tracking new one
    if (pageViewId.current) {
      updatePageView();
    }
    trackPageView();
  }, [location.pathname, trackPageView, updatePageView]);

  // Handle page visibility change and beforeunload
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        updatePageView();
        updateSessionHeartbeat();
      }
    };

    const handleBeforeUnload = () => {
      updatePageView();
      updateSessionHeartbeat();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [updatePageView, updateSessionHeartbeat]);

  return { visitorId, sessionId };
}

// ============== AIRBNB CLICK TRACKING ==============

export type AirbnbLinkLocation = 
  | 'header_book_now' 
  | 'hero_cta' 
  | 'welcome_learn_more' 
  | 'bottom_cta' 
  | 'booking_form' 
  | 'apartment_card'
  | 'mobile_menu';

export type AirbnbSuite = 'entire_place' | '7_person' | '12_person' | 'other';

interface TrackAirbnbClickParams {
  linkUrl: string;
  linkLocation: AirbnbLinkLocation;
  suite: AirbnbSuite;
  linkLabel?: string;
}

// Dedupe tracking - same click within 5 seconds
const clickDedupeMap: Record<string, number> = {};
const CLICK_DEDUPE_MS = 5000;

export const trackAirbnbClick = async ({
  linkUrl,
  linkLocation,
  suite,
  linkLabel,
}: TrackAirbnbClickParams) => {
  if (isTrackingExcluded()) return;

  // Use exported getters to ensure we get initialized values
  const sessionId = getSessionId();
  const visitorId = getVisitorId();
  
  if (!sessionId) {
    console.warn('[Analytics] No session ID available for click tracking');
    return;
  }

  // Dedupe check
  const dedupeKey = `${sessionId}-${linkLocation}-${linkUrl}`;
  const now = Date.now();
  const lastClick = clickDedupeMap[dedupeKey];
  
  if (lastClick && (now - lastClick) < CLICK_DEDUPE_MS) {
    console.log('[Analytics] Duplicate Airbnb click blocked:', dedupeKey);
    return;
  }
  
  clickDedupeMap[dedupeKey] = now;

  const attribution = getAttribution();

  try {
    const insertData = {
      session_id: sessionId,
      visitor_id: visitorId,
      destination_url: linkUrl,
      page_path: window.location.pathname,
      link_text: linkLabel || linkLocation,
      button_id: linkLocation,
      button_class: suite,
      device_type: getDeviceType(),
      utm_source: attribution?.utm_source || null,
      utm_campaign: attribution?.utm_campaign || null,
    };
    
    console.log('[Analytics] Inserting Airbnb click:', insertData);
    
    const { error } = await supabase.from('analytics_outbound_clicks').insert(insertData);
    
    if (error) {
      console.error('[Analytics] Supabase insert error:', error);
    } else {
      console.log('[Analytics] Airbnb click tracked successfully:', { linkLocation, suite, linkUrl });
    }
  } catch (error) {
    console.error('[Analytics] Failed to track Airbnb click:', error);
  }
};

// Helper function to extract suite from URL
export const getSuiteFromUrl = (url: string): AirbnbSuite => {
  if (url.includes('ZiLcS9MN')) return 'entire_place';
  if (url.includes('aM4JIC4O')) return '7_person';
  if (url.includes('17ciaUP9')) return '12_person';
  return 'other';
};
