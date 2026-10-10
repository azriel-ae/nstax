import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#f7f6f2]">
      <Card className="w-full max-w-lg mx-4 shadow-sm border border-[#e6e2d9] bg-white rounded-2xl">
        <CardContent className="pt-8 pb-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="relative">
              <div className="absolute inset-0 bg-[#fbeeeb] rounded-full" />
              <AlertCircle className="relative h-16 w-16 text-[#a6483a]" />
            </div>
          </div>

          <h1 className="text-4xl font-extrabold text-[#1c1b18] mb-2 tracking-tight">404</h1>

          <h2 className="text-xl font-semibold text-[#1c1b18] mb-4">
            Page Not Found
          </h2>

          <p className="text-[#6f6d66] mb-8 leading-relaxed">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={handleGoHome}
              className="bg-[#1c1b18] hover:bg-black text-white px-6 py-2.5 rounded-lg transition-all duration-200"
            >
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
