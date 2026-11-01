import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { RealtimeEvent } from '@shared/types';
import { clearActivity, pruneActivities, recordActivity } from '../lib/activity';
import { clearDesignerStream, recordDesignerStatusEvent, recordDesignerStreamEvent } from '../lib/designerStream';
import { clearTrainerStream, recordTrainerStatusEvent, recordTrainerStreamEvent } from '../lib/trainerStream';
import { useToast } from '../lib/toast';

export function useRealtime(): boolean {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event: RealtimeEvent & { type: string };
      try {
        event = JSON.parse(message.data) as RealtimeEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case 'task.created':
        case 'task.updated':
          void queryClient.invalidateQueries({ queryKey: ['tasks'] });
          void queryClient.invalidateQueries({ queryKey: ['task', event.taskId] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
          break;
        case 'turn.updated':
          clearActivity(event.turnId);
          void queryClient.invalidateQueries({ queryKey: ['task', event.taskId] });
          void queryClient.invalidateQueries({ queryKey: ['turn', event.taskId, event.turnId] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'message.appended':
          void queryClient.invalidateQueries({ queryKey: ['turn', event.taskId, event.turnId] });
          void queryClient.invalidateQueries({ queryKey: ['task', event.taskId] });
          break;
        case 'agent.activity':
          recordActivity(event);
          pruneActivities();
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'agent.status':
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'feedback.created':
        case 'feedback.updated':
          void queryClient.invalidateQueries({ queryKey: ['feedback'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'settings.updated':
          void queryClient.invalidateQueries({ queryKey: ['settings'] });
          void queryClient.invalidateQueries({ queryKey: ['designer-profile'] });
          void queryClient.invalidateQueries({ queryKey: ['trainer-profile'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'config.updated':
          void queryClient.invalidateQueries({ queryKey: ['agents'] });
          void queryClient.invalidateQueries({ queryKey: ['skills'] });
          void queryClient.invalidateQueries({ queryKey: ['tools'] });
          void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
          void queryClient.invalidateQueries({ queryKey: ['settings'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          void queryClient.invalidateQueries({ queryKey: ['designer-session'] });
          void queryClient.invalidateQueries({ queryKey: ['designer-profile'] });
          void queryClient.invalidateQueries({ queryKey: ['trainer-session'] });
          void queryClient.invalidateQueries({ queryKey: ['trainer-profile'] });
          break;
        case 'designer.session':
          void queryClient.invalidateQueries({ queryKey: ['designer-sessions'] });
          break;
        case 'designer.message':
          clearDesignerStream(event.sessionId);
          void queryClient.invalidateQueries({ queryKey: ['designer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['designer-session', event.sessionId] });
          break;
        case 'designer.delta':
        case 'designer.reasoning':
          recordDesignerStreamEvent(event);
          break;
        case 'designer.proposal':
          void queryClient.invalidateQueries({ queryKey: ['designer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['designer-session', event.sessionId] });
          break;
        case 'designer.status':
          recordDesignerStatusEvent(event);
          if (event.detail === 'idle') clearDesignerStream(event.sessionId);
          void queryClient.invalidateQueries({ queryKey: ['designer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'trainer.session':
          void queryClient.invalidateQueries({ queryKey: ['trainer-sessions'] });
          break;
        case 'trainer.message':
          clearTrainerStream(event.sessionId);
          void queryClient.invalidateQueries({ queryKey: ['trainer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['trainer-session', event.sessionId] });
          break;
        case 'trainer.delta':
        case 'trainer.reasoning':
          recordTrainerStreamEvent(event);
          break;
        case 'trainer.proposal':
          void queryClient.invalidateQueries({ queryKey: ['trainer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['trainer-session', event.sessionId] });
          break;
        case 'trainer.status':
          recordTrainerStatusEvent(event);
          if (event.detail === 'idle') clearTrainerStream(event.sessionId);
          void queryClient.invalidateQueries({ queryKey: ['trainer-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          break;
        case 'reset':
          toast.info('系统已清空运行数据与工作目录');
          queryClient.clear();
          navigate('/');
          break;
        default:
          break;
      }
    };
    return () => source.close();
  }, [navigate, queryClient, toast]);

  return connected;
}
