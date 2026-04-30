import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ForceGraph2D from 'react-force-graph-2d';
import { useApi } from '../lib/api';

type GraphData = {
  nodes: { id: string; label: string; slug: string; tags: string[]; categoryId: string | null }[];
  links: { source: string; target: string }[];
};

export default function GraphPage() {
  const api = useApi();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const { data } = useQuery({
    queryKey: ['graph'],
    queryFn: () => api.get<GraphData>('/api/graph'),
  });

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(() => {
      const r = ref.current!.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-200 px-6 py-4 dark:border-ink-800">
        <h1 className="text-2xl font-semibold tracking-tight">Graph</h1>
        <p className="text-sm text-ink-500">Pages and their backlinks. Click a node to open it.</p>
      </div>
      <div ref={ref} className="flex-1">
        {data && data.nodes.length > 0 && (
          <ForceGraph2D
            graphData={data}
            width={size.w}
            height={size.h}
            backgroundColor="transparent"
            nodeLabel="label"
            linkColor={() => 'rgba(120,120,140,0.4)'}
            nodeCanvasObject={(node, ctx) => {
              const label = (node as { label?: string }).label ?? '';
              ctx.font = '11px Inter, sans-serif';
              ctx.fillStyle = '#f8336d';
              ctx.beginPath();
              ctx.arc((node as { x: number }).x, (node as { y: number }).y, 4, 0, 2 * Math.PI);
              ctx.fill();
              ctx.fillStyle = '#888b96';
              ctx.fillText(
                label,
                (node as { x: number }).x + 6,
                (node as { y: number }).y + 4,
              );
            }}
            onNodeClick={(node) => {
              const slug = (node as unknown as { slug: string }).slug;
              if (slug) navigate(`/p/${slug}`);
            }}
          />
        )}
        {data && data.nodes.length === 0 && (
          <div className="flex h-full items-center justify-center text-ink-500">
            No pages yet — generate some from your inbox.
          </div>
        )}
      </div>
    </div>
  );
}
