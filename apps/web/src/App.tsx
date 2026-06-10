import { TooltipProvider } from "@/components/ui/tooltip";
import { Assistant } from "@/components/assistant";

function App() {
  return (
    <TooltipProvider>
      <Assistant />
    </TooltipProvider>
  );
}

export default App;
