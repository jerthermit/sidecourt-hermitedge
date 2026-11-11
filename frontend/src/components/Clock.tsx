import React, { useEffect, useState } from 'react';

export const Clock: React.FC<{ timezone?: string }> = ({ timezone = 'Australia/Sydney' }) => {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <time className="clock" dateTime={time.toISOString()}>
      <span>{time.toLocaleTimeString('en-AU', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
      })}</span>
      <small>{timezone.split('/').at(-1)?.replace(/_/g, ' ')}</small>
    </time>
  );
};
