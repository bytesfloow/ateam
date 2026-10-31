import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AgentsPage } from './pages/AgentsPage';
import { DesignerPage } from './pages/DesignerPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { PipelineEditorPage } from './pages/PipelineEditorPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SkillsPage } from './pages/SkillsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { ToolsPage } from './pages/ToolsPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TasksPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="designer" element={<DesignerPage />} />
        <Route path="pipelines" element={<PipelinesPage />} />
        <Route path="pipelines/new" element={<PipelineEditorPage />} />
        <Route path="pipelines/:pipelineId/edit" element={<PipelineEditorPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
